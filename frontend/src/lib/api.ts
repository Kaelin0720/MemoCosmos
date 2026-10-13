import {
  parseAgentStatus,
  parseConversation,
  parseConversationPage,
  parseMessagePage,
  parseRun,
  type AgentConfig,
} from "./chat-types";
import {
  parseNoteDetail,
  parseNoteList,
  parseNoteError,
  parseVersions,
  parseExternal,
  type NoteInput,
  type NoteErrorDetails,
  type NoteQuery,
} from "./note-types";
import { parseGraph, parseJob, parseJobs, parseSearch } from "./memory-types";
import { uiMessage } from "./i18n";

export type Tag = {
  id: string;
  name: string;
  description: string;
  created_by: "user" | "ai";
  created_at: string;
  updated_at: string;
};

export type TagInput = Pick<Tag, "name" | "description">;
export type ConnectionState = "checking" | "online" | "offline" | "error";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public details: NoteErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseTag(value: unknown): Tag {
  if (
    !isObject(value) ||
    !["id", "name", "description", "created_at", "updated_at"].every(
      (key) => typeof value[key] === "string",
    ) ||
    !value.id ||
    !["user", "ai"].includes(String(value.created_by)) ||
    !Number.isFinite(Date.parse(String(value.created_at))) ||
    !Number.isFinite(Date.parse(String(value.updated_at)))
  ) {
    throw new ApiError("invalid_response", "服务返回的标签格式不正确，请刷新后重试。");
  }
  return value as Tag;
}

// A token lives only in this process' memory. Writes are retried only after a
// definite invalid-token response, never after an uncertain network failure.
export class LocalApi {
  readonly baseUrl: string;
  private token: string | null = null;
  private bootstrapFlight: Promise<string> | null = null;
  private connection: ConnectionState = "checking";
  private listeners = new Set<() => void>();

  constructor(
    baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ??
      (process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:8000"),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.connection;

  private setConnection(state: ConnectionState) {
    if (this.connection === state) return;
    this.connection = state;
    for (const listener of this.listeners) listener();
  }

  private async send(
    path: string,
    init: RequestInit = {},
    timeoutMs: number | null = 8000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout =
      timeoutMs === null ? null : setTimeout(() => controller.abort("timeout"), timeoutMs);
    const abort = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        signal: timeoutMs === null && init.signal ? init.signal : controller.signal,
      });
      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        const error = isObject(body) && isObject(body.error) ? body.error : null;
        const code = typeof error?.code === "string" ? error.code : "request_failed";
        const message =
          typeof error?.message === "string"
            ? error.message
            : `请求未完成（${response.status}），请稍后重试。`;
        throw new ApiError(code, message, response.status, parseNoteError(error));
      }
      return response;
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (error instanceof ApiError) {
        if ([401, 403].includes(error.status) || error.status >= 500) this.setConnection("error");
        throw error;
      }
      this.setConnection("offline");
      const write = init.method && init.method !== "GET";
      throw new ApiError(
        controller.signal.reason === "timeout" ? "timeout" : "network_error",
        write
          ? "未收到服务确认，结果尚未确定。请刷新列表核对后再提交。"
          : "无法连接本机服务，请确认后端已启动，然后重试。",
      );
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abort);
    }
  }

  private bootstrap(): Promise<string> {
    if (this.token) return Promise.resolve(this.token);
    if (this.bootstrapFlight) return this.bootstrapFlight;
    const flight = (async () => {
      const response = await this.send("/api/v1/bootstrap");
      const body: unknown = await response.json();
      if (!isObject(body) || typeof body.local_token !== "string" || !body.local_token) {
        throw new ApiError("invalid_response", "无法建立本机会话，请重试连接。");
      }
      this.token = body.local_token;
      return body.local_token;
    })();
    this.bootstrapFlight = flight;
    void flight
      .finally(() => {
        if (this.bootstrapFlight === flight) this.bootstrapFlight = null;
      })
      .catch(() => undefined);
    return flight;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs: number | null = 8000,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.bootstrap();
      const headers = new Headers(init.headers);
      headers.set("X-Local-Token", token);
      if (init.body && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      try {
        const response = await this.send(path, { ...init, headers }, timeoutMs);
        this.setConnection("online");
        return response;
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 401 &&
          error.code === "invalid_local_token"
        ) {
          if (this.token === token) this.token = null;
          if (attempt === 0) continue;
        }
        throw error;
      }
    }
    throw new ApiError("invalid_local_token", "本机会话已失效，请重新检查连接。", 401);
  }

  async checkConnection(): Promise<void> {
    this.setConnection("checking");
    try {
      const response = await this.send("/health");
      const body: unknown = await response.json();
      if (!isObject(body) || body.status !== "ok") {
        throw new ApiError("invalid_response", "服务健康检查未通过。");
      }
      await this.bootstrap();
      this.setConnection("online");
    } catch (error) {
      this.setConnection(
        error instanceof ApiError && (error.status || error.code === "invalid_response")
          ? "error"
          : "offline",
      );
      throw error;
    }
  }

  async listTags(query = "", signal?: AbortSignal): Promise<{ items: Tag[]; total: number }> {
    const search = query.trim() ? `?${new URLSearchParams({ q: query.trim() })}` : "";
    const response = await this.request(`/api/v1/tags${search}`, { signal });
    const body: unknown = await response.json();
    if (
      !isObject(body) ||
      !Array.isArray(body.items) ||
      !Number.isInteger(body.total) ||
      Number(body.total) < 0
    ) {
      throw new ApiError("invalid_response", "服务返回的标签列表格式不正确。");
    }
    return { items: body.items.map(parseTag), total: Number(body.total) };
  }

  async createTag(input: TagInput): Promise<Tag> {
    const response = await this.request("/api/v1/tags", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return parseTag(await response.json());
  }

  async updateTag(id: string, input: TagInput): Promise<Tag> {
    const response = await this.request(`/api/v1/tags/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return parseTag(await response.json());
  }

  async deleteTag(id: string): Promise<void> {
    const response = await this.request(`/api/v1/tags/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (response.status !== 204)
      throw new ApiError("invalid_response", "服务尚未确认删除，请刷新列表核对。");
  }

  async agentStatus(signal?: AbortSignal) {
    return parseAgentStatus(await (await this.request("/api/v1/agent/status", { signal })).json());
  }
  async notes(signal?: AbortSignal, query: NoteQuery = {}) {
    const search = new URLSearchParams();
    if (query.q) search.set("q", query.q);
    if (query.tag_id) search.set("tag_id", query.tag_id);
    if (query.folder !== undefined) search.set("folder", query.folder);
    return parseNoteList(
      await (
        await this.request(`/api/v1/notes${search.size ? `?${search}` : ""}`, { signal })
      ).json(),
    );
  }
  async note(id: string, signal?: AbortSignal) {
    return parseNoteDetail(
      await (await this.request(`/api/v1/notes/${encodeURIComponent(id)}`, { signal })).json(),
    );
  }
  async createNote(input: NoteInput) {
    const response = await this.request("/api/v1/notes", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (response.status !== 201)
      throw new ApiError("invalid_response", "服务尚未确认文档保存，结果未确认。请读取目录核对。");
    return parseNoteDetail(await response.json());
  }
  async updateNote(id: string, input: NoteInput, version: number) {
    return parseNoteDetail(
      await (
        await this.request(`/api/v1/notes/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ ...input, expected_version: version }),
        })
      ).json(),
    );
  }
  async deleteNote(id: string, version: number) {
    const response = await this.request(`/api/v1/notes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ expected_version: version }),
    });
    if (response.status !== 204)
      throw new ApiError("invalid_response", "尚未确认删除，请重新读取文档核对。");
  }
  async noteVersions(id: string, signal?: AbortSignal) {
    return parseVersions(
      await (
        await this.request(`/api/v1/notes/${encodeURIComponent(id)}/versions`, { signal })
      ).json(),
    );
  }
  async externalNote(id: string, signal?: AbortSignal) {
    return parseExternal(
      await (
        await this.request(`/api/v1/notes/${encodeURIComponent(id)}/external`, { signal })
      ).json(),
    );
  }
  async importExternal(id: string, version: number, hash: string) {
    return parseNoteDetail(
      await (
        await this.request(`/api/v1/notes/${encodeURIComponent(id)}/import-external`, {
          method: "POST",
          body: JSON.stringify({ expected_version: version, file_hash: hash }),
        })
      ).json(),
    );
  }
  async memorySearch(q: string, tagIds: string[] = [], signal?: AbortSignal) {
    const query = new URLSearchParams({ q, limit: "12" });
    if (tagIds.length) query.set("tag_ids", tagIds.join(","));
    return parseSearch(
      await (await this.request(`/api/v1/memory/search?${query}`, { signal })).json(),
    );
  }
  async memoryGraph(signal?: AbortSignal) {
    return parseGraph(await (await this.request("/api/v1/memory/graph", { signal })).json());
  }
  async memoryJobs(conversationId?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: "20" });
    if (conversationId) query.set("conversation_id", conversationId);
    return parseJobs(await (await this.request(`/api/v1/memory/jobs?${query}`, { signal })).json());
  }
  async retryMemoryJob(id: string) {
    return parseJob(
      await (
        await this.request(`/api/v1/memory/jobs/${encodeURIComponent(id)}/retry`, {
          method: "POST",
          body: "{}",
        })
      ).json(),
    );
  }
  async resolveMemoryJob(id: string, action: "confirm" | "dismiss", clarification?: string) {
    return parseJob(
      await (
        await this.request(`/api/v1/memory/jobs/${encodeURIComponent(id)}/resolve`, {
          method: "POST",
          body: JSON.stringify({
            action,
            ...(clarification?.trim() ? { clarification: clarification.trim() } : {}),
          }),
        })
      ).json(),
    );
  }
  async memorySettings(signal?: AbortSignal) {
    const value: unknown = await (await this.request("/api/v1/memory/settings", { signal })).json();
    if (!isObject(value) || typeof value.auto_memory !== "boolean")
      throw new Error("自动整理设置格式不正确。");
    return { auto_memory: value.auto_memory };
  }
  async setAutoMemory(auto_memory: boolean) {
    const value: unknown = await (
      await this.request("/api/v1/memory/settings", {
        method: "PUT",
        body: JSON.stringify({ auto_memory }),
      })
    ).json();
    if (!isObject(value) || value.auto_memory !== auto_memory)
      throw new Error("尚未确认自动整理设置。请重新读取。");
    return { auto_memory };
  }
  async exportMemory() {
    const response = await this.request("/api/v1/memory/export", {}, 60000);
    const blob = await response.blob();
    const magic = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (magic[0] !== 80 || magic[1] !== 75) throw new Error("服务未返回有效的记忆 ZIP 包。");
    return blob;
  }
  async importMemory(file: File) {
    if (file.size > 100 * 1024 * 1024 || !file.size)
      throw new Error("请选择不超过 100 MiB 的 ZIP 记忆包。");
    const value: unknown = await (
      await this.request(
        "/api/v1/memory/import",
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
        120000,
      )
    ).json();
    if (
      !isObject(value) ||
      typeof value.memory_dir !== "string" ||
      value.requires_restart !== true ||
      typeof value.message !== "string"
    )
      throw new Error("恢复结果未确认，请保留当前库并重新核对。");
    return {
      memory_dir: value.memory_dir,
      requires_restart: true as const,
      message: value.message,
    };
  }
  async saveAgentConfig(input: AgentConfig) {
    return parseAgentStatus(
      await (
        await this.request("/api/v1/agent/config", { method: "PUT", body: JSON.stringify(input) })
      ).json(),
    );
  }
  async conversations(offset = 0, signal?: AbortSignal) {
    return parseConversationPage(
      await (
        await this.request(`/api/v1/conversations?limit=50&offset=${offset}`, { signal })
      ).json(),
    );
  }
  async createConversation() {
    return parseConversation(
      await (await this.request("/api/v1/conversations", { method: "POST", body: "{}" })).json(),
    );
  }
  async conversation(id: string, signal?: AbortSignal) {
    return parseConversation(
      await (
        await this.request(`/api/v1/conversations/${encodeURIComponent(id)}`, { signal })
      ).json(),
    );
  }
  async messages(id: string, before?: number, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: "50" });
    if (before !== undefined) query.set("before_seq", String(before));
    return parseMessagePage(
      await (
        await this.request(`/api/v1/conversations/${encodeURIComponent(id)}/messages?${query}`, {
          signal,
        })
      ).json(),
    );
  }
  async sendMessage(id: string, clientMessageId: string, content: string) {
    return parseRun(
      await (
        await this.request(`/api/v1/conversations/${encodeURIComponent(id)}/messages`, {
          method: "POST",
          body: JSON.stringify({ client_message_id: clientMessageId, content }),
        })
      ).json(),
    );
  }
  async run(id: string) {
    return parseRun(await (await this.request(`/api/v1/runs/${encodeURIComponent(id)}`)).json());
  }
  async runByClient(id: string, clientMessageId: string) {
    return parseRun(
      await (
        await this.request(
          `/api/v1/conversations/${encodeURIComponent(id)}/runs/by-client-message/${encodeURIComponent(clientMessageId)}`,
        )
      ).json(),
    );
  }
  async cancelRun(id: string) {
    return parseRun(
      await (
        await this.request(`/api/v1/runs/${encodeURIComponent(id)}/cancel`, {
          method: "POST",
          body: "{}",
        })
      ).json(),
    );
  }
  async runEvents(id: string, signal: AbortSignal) {
    const response = await this.request(
      `/api/v1/runs/${encodeURIComponent(id)}/events`,
      { signal, headers: { Accept: "text/event-stream" } },
      null,
    );
    if (
      !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
      !response.body
    )
      throw new ApiError("invalid_stream", "实时响应格式不正确，请重新读取运行状态。");
    return response.body;
  }
}

export const api = new LocalApi();
export const errorMessage = (error: unknown) =>
  uiMessage(error instanceof Error ? error.message : "操作未完成，请重试。");
