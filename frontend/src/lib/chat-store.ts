import { api, ApiError, errorMessage } from "./api";
import {
  isActive,
  isRecord,
  parseMessage,
  parseRun,
  type AgentStatus,
  type Conversation,
  type Message,
  type Run,
} from "./chat-types";
import { readSse } from "./sse";

type Submission = {
  clientId: string;
  content: string;
  status: "sending" | "unknown" | "not_found" | "accepted";
};
export type ChatState = {
  conversation: Conversation | null;
  messages: Message[];
  run: Run | null;
  draft: string;
  pending: Submission | null;
  loading: boolean;
  olderLoading: boolean;
  hasMore: boolean;
  submitting: boolean;
  checking: boolean;
  cancelling: boolean;
  stopRequested: boolean;
  stream: "idle" | "connecting" | "streaming" | "recovering" | "disconnected";
  loadError: string;
  error: string;
  olderError: string;
};
const initial: ChatState = {
  conversation: null,
  messages: [],
  run: null,
  draft: "",
  pending: null,
  loading: false,
  olderLoading: false,
  hasMore: false,
  submitting: false,
  checking: false,
  cancelling: false,
  stopRequested: false,
  stream: "idle",
  loadError: "",
  error: "",
  olderError: "",
};

export class ChatSession {
  private state: ChatState;
  private serverState: ChatState;
  private listeners = new Set<() => void>();
  private loadController: AbortController | null = null;
  private streamController: AbortController | null = null;
  private connectionFlight: { runId: string } | null = null;
  private loadEpoch = 0;
  constructor(readonly id: string | null) {
    this.state = { ...initial, loading: Boolean(id) };
    this.serverState = this.state;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  getServerSnapshot = () => this.serverState;
  private set(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setDraft(value: string) {
    this.set({ draft: value });
  }
  initialize(conversation: Conversation, draft = "") {
    if (conversation.id !== this.id) throw new Error("会话身份不一致。");
    this.set({ conversation, draft, loading: false });
  }
  private validateRun(run: Run) {
    if (run.conversation_id !== this.id) throw new Error("运行与当前会话不匹配，请重新读取。");
    return run;
  }
  private updateRun(run: Run) {
    const current = this.state.run;
    // A slow status read must not undo a terminal SSE event or cancellation.
    if (current?.id === run.id && !isActive(current) && isActive(run)) return current;
    this.set({ run });
    return run;
  }
  private merge(items: Message[], protectStreaming = true) {
    if (items.some((item) => item.conversation_id !== this.id))
      throw new Error("消息与当前会话不匹配，请重新读取。");
    const map = new Map(this.state.messages.map((message) => [message.id, message]));
    for (const item of items) {
      const existing = map.get(item.id);
      if (
        existing &&
        !["pending", "running"].includes(existing.status) &&
        ["pending", "running"].includes(item.status)
      )
        continue;
      if (
        protectStreaming &&
        this.streamController &&
        isActive(this.state.run) &&
        item.id === this.state.run?.assistant_message_id &&
        ["pending", "running"].includes(item.status) &&
        map.has(item.id)
      )
        continue;
      map.set(item.id, item);
    }
    this.set({ messages: [...map.values()].sort((a, b) => a.seq - b.seq) });
  }
  private async syncMessages(signal?: AbortSignal) {
    if (!this.id) return;
    const page = await api.messages(this.id, undefined, signal);
    if (signal?.aborted) return;
    const alreadyEarlier =
      this.state.messages.length &&
      page.items.length &&
      this.state.messages[0].seq < page.items[0].seq;
    this.merge(page.items);
    this.set({ hasMore: alreadyEarlier ? this.state.hasMore : page.has_more });
    if (
      this.state.pending?.status === "accepted" &&
      page.items.some((message) => message.id === this.state.run?.user_message_id)
    )
      this.set({ pending: null });
  }
  async load() {
    if (!this.id) return;
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    const epoch = ++this.loadEpoch;
    this.set({ loading: true, loadError: "" });
    try {
      const conversation = await api.conversation(this.id, controller.signal);
      await this.syncMessages(controller.signal);
      if (controller.signal.aborted || epoch !== this.loadEpoch) return;
      this.set({ conversation });
      const runId =
        conversation.active_run_id || this.state.run?.id || this.state.messages.at(-1)?.run_id;
      if (runId) {
        const runAtRead = this.state.run?.id;
        const run = this.validateRun(await api.run(runId));
        if (run.id !== runId) throw new Error("服务返回的运行身份不一致。");
        if (controller.signal.aborted || epoch !== this.loadEpoch) return;
        if (!this.state.run || this.state.run.id === run.id || this.state.run.id === runAtRead) {
          const current = this.updateRun(run);
          if (isActive(current)) void this.connect(current);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && epoch === this.loadEpoch)
        this.set({ loadError: errorMessage(error) });
    } finally {
      if (epoch === this.loadEpoch) this.set({ loading: false });
    }
  }
  async older() {
    if (!this.id || this.state.olderLoading || !this.state.hasMore || !this.state.messages.length)
      return;
    this.set({ olderLoading: true, olderError: "" });
    try {
      const page = await api.messages(this.id, this.state.messages[0].seq);
      this.merge(page.items);
      this.set({ hasMore: page.has_more });
    } catch (error) {
      this.set({ olderError: errorMessage(error) });
    } finally {
      this.set({ olderLoading: false });
    }
  }
  private accept(run: Run, submission: Submission) {
    this.validateRun(run);
    if (run.client_message_id !== submission.clientId)
      throw new Error("服务返回的提交身份不一致，请先核对运行状态。");
    this.set({
      run,
      pending: { ...submission, status: "accepted" },
      draft: this.state.draft === submission.content ? "" : this.state.draft,
      error: "",
      stopRequested: false,
    });
    void this.syncMessages().catch((error) => this.set({ loadError: errorMessage(error) }));
    if (isActive(run)) void this.connect(run);
    else this.set({ stream: "idle" });
    void api
      .conversation(this.id!)
      .then((conversation) => this.set({ conversation }))
      .catch(() => undefined);
  }
  async send(retry = false) {
    if (
      !this.id ||
      this.state.submitting ||
      isActive(this.state.run) ||
      (this.state.pending && !(retry && this.state.pending.status === "not_found"))
    )
      return;
    const submission: Submission =
      retry && this.state.pending
        ? { ...this.state.pending, status: "sending" }
        : { clientId: crypto.randomUUID(), content: this.state.draft, status: "sending" };
    if (!submission.content.trim() || [...submission.content].length > 20000) return;
    this.set({ submitting: true, pending: submission, error: "" });
    try {
      this.accept(
        await api.sendMessage(this.id, submission.clientId, submission.content),
        submission,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status && error.status < 500) {
        this.set({ pending: null, error: errorMessage(error) });
        if (error.code === "conversation_busy") void this.load();
      } else {
        this.set({
          pending: { ...submission, status: "unknown" },
          error: "提交结果尚未确认，正在核对本次运行。原消息不会自动重发。",
        });
        void this.checkSubmission();
      }
    } finally {
      this.set({ submitting: false });
    }
  }
  async checkSubmission() {
    const submission = this.state.pending;
    if (!this.id || !submission || this.state.checking || submission.status === "accepted") return;
    this.set({ checking: true });
    try {
      this.accept(await api.runByClient(this.id, submission.clientId), submission);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && error.code === "run_not_found")
        this.set({
          pending: { ...submission, status: "not_found" },
          error: "暂未查到本次提交。可继续核对，或手动重新提交同一条原消息。",
        });
      else
        this.set({
          pending: { ...submission, status: "unknown" },
          error: "暂时无法核对提交结果。原消息和提交 ID已保留，请恢复连接后再次核对。",
        });
    } finally {
      this.set({ checking: false });
    }
  }
  async cancel() {
    const run = this.state.run;
    if (!run || !isActive(run) || this.state.cancelling) return;
    this.set({ cancelling: true, error: "" });
    try {
      const result = this.validateRun(await api.cancelRun(run.id));
      if (result.id !== run.id) throw new Error("停止响应的运行身份不一致。");
      if (this.state.run?.id !== run.id) return;
      const current = this.updateRun(result);
      this.set({ stopRequested: isActive(current) });
      if (!isActive(current)) {
        this.streamController?.abort("terminal");
        this.set({ stream: "idle" });
        await this.syncMessages();
      }
    } catch (error) {
      this.set({ error: "停止结果尚未确认，请核对运行状态。" });
      await this.reconcile(run.id).catch(() => this.set({ error: errorMessage(error) }));
    } finally {
      this.set({ cancelling: false });
    }
  }
  private async reconcile(id: string) {
    const run = this.validateRun(await api.run(id));
    if (run.id !== id) throw new Error("服务返回的运行身份不一致。");
    if (this.state.run?.id !== id) return run;
    const current = this.updateRun(run);
    await this.syncMessages();
    if (!isActive(current)) {
      this.set({ stream: "idle", stopRequested: false });
      this.streamController?.abort("terminal");
    }
    return current;
  }
  async reconnect() {
    const run = this.state.run;
    if (!run || this.state.checking) return;
    this.set({ checking: true, error: "" });
    try {
      const current = await this.reconcile(run.id);
      if (isActive(current)) void this.connect(current);
    } catch (error) {
      this.set({ error: errorMessage(error) });
    } finally {
      this.set({ checking: false });
    }
  }
  private async connect(run: Run) {
    if (this.state.run?.id !== run.id || !isActive(this.state.run)) return;
    if (this.connectionFlight?.runId === run.id) return;
    const flight = { runId: run.id };
    this.connectionFlight = flight;
    this.streamController?.abort("replaced");
    try {
      await this.consume(run, flight);
    } finally {
      if (this.connectionFlight === flight) this.connectionFlight = null;
    }
  }
  private async consume(run: Run, flight: { runId: string }) {
    for (
      let attempt = 0;
      attempt < 3 &&
      this.connectionFlight === flight &&
      isActive(this.state.run) &&
      this.state.run?.id === run.id;
      attempt++
    ) {
      const controller = new AbortController();
      this.streamController = controller;
      this.set({ stream: attempt ? "recovering" : "connecting" });
      let terminal = false,
        snapshot = false;
      const connectTimer = setTimeout(() => controller.abort("connect_timeout"), 20000);
      const totalTimer = setTimeout(() => controller.abort("stream_timeout"), 150000);
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const touch = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort("idle_timeout"), 45000);
      };
      try {
        const stream = await api.runEvents(run.id, controller.signal);
        clearTimeout(connectTimer);
        touch();
        for await (const event of readSse(stream, touch)) {
          if (this.connectionFlight !== flight || this.state.run?.id !== run.id) return;
          let value: unknown;
          try {
            value = JSON.parse(event.data);
          } catch {
            throw new Error("实时事件格式不正确，正在核对已保存的内容。");
          }
          if (!isRecord(value)) throw new Error("实时事件格式不正确。");
          if (
            event.event === "run.snapshot" ||
            ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(
              event.event,
            )
          ) {
            const current = this.validateRun(parseRun(value.run));
            const message = parseMessage(value.message);
            if (
              current.id !== run.id ||
              message.id !== current.assistant_message_id ||
              message.role !== "assistant" ||
              message.run_id !== current.id ||
              message.conversation_id !== this.id
            )
              throw new Error("实时事件的会话身份不一致。");
            if (
              event.event !== "run.snapshot" &&
              (!snapshot || event.event !== `run.${current.status}` || isActive(current))
            )
              throw new Error("实时终止状态不一致，请重新读取。");
            this.merge([message], false);
            this.updateRun(current);
            if (event.event === "run.snapshot") {
              snapshot = true;
              this.set({ stream: isActive(this.state.run) ? "streaming" : "idle" });
            } else {
              terminal = true;
              this.set({ stream: "idle", stopRequested: false, error: "" });
              break;
            }
          } else if (event.event === "message.delta") {
            if (!isActive(this.state.run)) return;
            if (
              !snapshot ||
              value.run_id !== run.id ||
              value.message_id !== run.assistant_message_id ||
              typeof value.delta !== "string"
            )
              throw new Error("实时增量缺少有效快照，请重新连接。");
            const message = this.state.messages.find((item) => item.id === value.message_id);
            if (!message) throw new Error("实时消息缺失，请重新读取。");
            this.merge(
              [{ ...message, content: message.content + value.delta, status: "running" }],
              false,
            );
          } else if (!snapshot) throw new Error("实时响应的第一条事件必须是运行快照。");
        }
      } catch {
        /* A broken transport never cancels or regenerates a server run. */
      } finally {
        clearTimeout(connectTimer);
        clearTimeout(totalTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (this.streamController === controller) this.streamController = null;
        controller.abort("reader_closed");
      }
      if (terminal) {
        await this.syncMessages().catch((error) => this.set({ loadError: errorMessage(error) }));
        return;
      }
      if (
        this.connectionFlight !== flight ||
        this.state.run?.id !== run.id ||
        !isActive(this.state.run)
      )
        return;
      this.set({ stream: "recovering" });
      try {
        const current = await this.reconcile(run.id);
        if (!isActive(current)) return;
      } catch {
        this.set({
          stream: "disconnected",
          error:
            "实时连接中断，暂时无法读取本机运行状态。恢复连接后可重新核对；原消息不会自动重发。",
        });
        return;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 500));
    }
    if (
      this.connectionFlight === flight &&
      this.state.run?.id === run.id &&
      isActive(this.state.run)
    )
      this.set({
        stream: "disconnected",
        error: "实时连接已中断，运行仍在本机继续。可以重新连接或停止，不会重新生成。",
      });
  }
}

const sessions = new Map<string, ChatSession>();
export function chatSession(id: string | null) {
  const key = id ?? "welcome";
  let session = sessions.get(key);
  if (!session) {
    session = new ChatSession(id);
    sessions.set(key, session);
  }
  return session;
}

type AgentState = { value: AgentStatus | null; loading: boolean; error: string };
const agentInitial: AgentState = { value: null, loading: true, error: "" };
class AgentStore {
  private state = agentInitial;
  private listeners = new Set<() => void>();
  private flight: Promise<void> | null = null;
  private revision = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  getServerSnapshot = () => agentInitial;
  set(value: AgentStatus) {
    this.revision++;
    this.state = { value, loading: false, error: "" };
    for (const listener of this.listeners) listener();
  }
  refresh() {
    if (this.flight) return this.flight;
    const revision = this.revision;
    this.flight = (async () => {
      try {
        const value = await api.agentStatus();
        if (revision === this.revision) this.set(value);
      } catch (error) {
        if (revision !== this.revision) return;
        this.state = { ...this.state, loading: false, error: errorMessage(error) };
        for (const listener of this.listeners) listener();
      } finally {
        this.flight = null;
      }
    })();
    return this.flight;
  }
}
export const agentStore = new AgentStore();
