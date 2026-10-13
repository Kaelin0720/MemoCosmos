"use client";
import { t, uiDate, uiMessage, useLocale } from "@/lib/i18n";
import { motion } from "motion/react";
import { WorkspaceSurface } from "@/components/motion-system";
import { ActionButton } from "@/components/motion-system";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Clock3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Tags,
  Star,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { api, errorMessage } from "@/lib/api";
import { agentStore, chatSession, type ChatSession } from "@/lib/chat-store";
import {
  isActive,
  isUuid,
  type Conversation,
  type Message,
  type RunStatus,
} from "@/lib/chat-types";
import { BrandMark } from "./ui";
import { Constellation } from "./constellation";
import { ChatMarkdown } from "./chat-markdown";
import { MemoryJobs } from "./memory-jobs";

const statusLabels: Record<RunStatus, string> = {
  pending: "等待生成",
  running: "正在生成",
  completed: "已完成",
  failed: "生成失败",
  cancelled: "已停止",
  interrupted: "运行已中断",
};
function dateLabel(value: string) {
  return uiDate(value, { month: "short", day: "numeric" });
}

function selectConversation(id: string) {
  window.history.pushState(null, "", `/?conversation=${encodeURIComponent(id)}`);
}

function MessageBubble({ message }: { message: Message }) {
  useLocale();
  return (
    <motion.article
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className={`chat-message ${message.role}`}
      data-message-id={message.id}
      aria-label={message.role === "user" ? t("用户消息") : t("助手消息")}
    >
      {message.role === "assistant" && (
        <div className="message-mark">
          <BrandMark />
        </div>
      )}
      <div className="message-body">
        {message.role === "user" ? (
          <p className="user-content">{message.content}</p>
        ) : message.content ? (
          <ChatMarkdown content={message.content} />
        ) : (
          <p className="empty-reply">
            {["pending", "running"].includes(message.status)
              ? t("正在思考…")
              : message.status === "completed"
                ? t("这次没有正文回复。")
                : t("没有生成正文，原始用户消息已保留。")}
          </p>
        )}
        {message.role === "assistant" && message.status !== "completed" && (
          <span className={`message-status ${message.status}`}>
            {t(statusLabels[message.status])}
            {message.content && !["pending", "running"].includes(message.status)
              ? t(" · 已保留回复片段")
              : ""}
          </span>
        )}
      </div>
    </motion.article>
  );
}

export function ChatWorkbench() {
  useLocale();
  const params = useSearchParams();
  const rawId = params.get("conversation");
  const valid = rawId === null || isUuid(rawId);
  const session = useMemo(() => chatSession(valid ? rawId : null), [rawId, valid]);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getServerSnapshot,
  );
  const agent = useSyncExternalStore(
    agentStore.subscribe,
    agentStore.getSnapshot,
    agentStore.getServerSnapshot,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<{
    items: Conversation[];
    total: number;
    loading: boolean;
    error: string;
  }>({ items: [], total: 0, loading: false, error: "" });
  const historyItems = useRef<Conversation[]>([]);
  const historyController = useRef<AbortController | null>(null);
  const [creating, setCreating] = useState(false);
  const createBusy = useRef(false);
  const [createError, setCreateError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const active = isActive(state.run);
  const uncertain = Boolean(
    state.pending && ["unknown", "not_found", "sending"].includes(state.pending.status),
  );
  const length = [...state.draft].length;
  const canSend =
    valid &&
    !creating &&
    !state.submitting &&
    !uncertain &&
    !active &&
    !state.loading &&
    !state.loadError &&
    Boolean(agent.value?.configured) &&
    !agent.error &&
    Boolean(state.draft.trim()) &&
    length <= 20000;

  const refreshHistory = useCallback(async (more = false) => {
    historyController.current?.abort();
    const controller = new AbortController();
    historyController.current = controller;
    setHistory((current) => ({ ...current, loading: true, error: "" }));
    try {
      const page = await api.conversations(
        more ? historyItems.current.length : 0,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const items = more
        ? [
            ...new Map(
              [...historyItems.current, ...page.items].map((item) => [item.id, item]),
            ).values(),
          ]
        : page.items;
      historyItems.current = items;
      setHistory({ items, total: page.total, loading: false, error: "" });
    } catch (error) {
      if (!controller.signal.aborted)
        setHistory((current) => ({ ...current, loading: false, error: errorMessage(error) }));
    }
  }, []);

  useEffect(() => {
    if (valid) void session.load();
    void agentStore.refresh();
    const visible = () => {
      if (document.visibilityState === "visible") {
        void agentStore.refresh();
        if (valid) void session.load();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [session, valid]);
  useEffect(() => {
    if (!historyOpen) return;
    const timer = setTimeout(() => void refreshHistory(), 0);
    return () => clearTimeout(timer);
  }, [historyOpen, refreshHistory]);
  useEffect(() => {
    if (state.run && !active && historyOpen) {
      const timer = setTimeout(() => void refreshHistory(), 0);
      return () => clearTimeout(timer);
    }
  }, [state.run, active, historyOpen, refreshHistory]);
  useEffect(() => {
    follow.current = true;
  }, [session]);
  const lastContent = state.messages.at(-1)?.content;
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [lastContent, state.messages.length, state.loading]);

  async function create(send = false) {
    if (createBusy.current) return;
    createBusy.current = true;
    setCreating(true);
    setCreateError("");
    const original = session.getSnapshot().draft;
    try {
      const conversation = await api.createConversation();
      const target = chatSession(conversation.id);
      target.initialize(conversation, send ? original : "");
      if (send) session.setDraft("");
      selectConversation(conversation.id);
      if (send) await target.send();
      requestAnimationFrame(() => input.current?.focus());
    } catch (error) {
      setCreateError(errorMessage(error));
      void refreshHistory();
    } finally {
      createBusy.current = false;
      setCreating(false);
    }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    follow.current = true;
    if (!session.id) await create(true);
    else await session.send();
  }
  async function older(target: ChatSession) {
    const element = scroll.current;
    const height = element?.scrollHeight ?? 0;
    await target.older();
    requestAnimationFrame(() => {
      if (element) element.scrollTop += element.scrollHeight - height;
    });
  }
  const pending = state.pending;
  const pendingVisible =
    pending &&
    (pending.status !== "accepted" ||
      !state.messages.some((item) => item.id === state.run?.user_message_id));
  const pendingBubble = pendingVisible && (
    <motion.article
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="chat-message user local-message"
      aria-label={t("提交中的用户原文")}
    >
      <div className="message-body">
        <p className="user-content">{pending.content}</p>
        <span className="message-status">
          {pending.status === "accepted"
            ? t("原文已接收，正在读取记录")
            : pending.status === "sending"
              ? t("正在提交 · 保存尚未确认")
              : t("提交结果待核对")}
        </span>
      </div>
    </motion.article>
  );

  return (
    <WorkspaceSurface className="workbench" aria-label={t("工作台")}>
      <div className="conversation-window glass-panel chat-window">
        <div className="window-bar">
          <div className="window-title">
            <Star className="tiny-star" size={16} aria-hidden="true" />
            <h1>{state.conversation?.title ?? t("新的对话")}</h1>
            {active && <span className="stage-badge">{t(statusLabels[state.run!.status])}</span>}
          </div>
          <div className="window-actions">
            <Dropdown.Root open={historyOpen} onOpenChange={setHistoryOpen}>
              <Dropdown.Trigger className="quiet-button">
                <Clock3 size={15} />
                <span>{t("会话历史")}</span>
                <ChevronDown size={13} />
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content
                  className="space-menu history-menu chat-history"
                  align="end"
                  sideOffset={10}
                >
                  <Dropdown.Label className="menu-label">
                    {t("本机原始对话 · ")}
                    {history.total}
                    {t("个")}
                  </Dropdown.Label>
                  {history.items.map((item) => (
                    <Dropdown.Item
                      key={item.id}
                      className={item.id === session.id ? "active" : ""}
                      onSelect={() => selectConversation(item.id)}
                    >
                      <span className="history-title">
                        {item.title}
                        <small>
                          {dateLabel(item.updated_at)}
                          {item.active_run_id ? t(" · 运行中") : ""}
                        </small>
                      </span>
                      {item.id === session.id && <Check size={14} />}
                    </Dropdown.Item>
                  ))}
                  {history.loading && (
                    <p className="history-info" role="status">
                      {t("正在读取会话…")}
                    </p>
                  )}
                  {history.error && (
                    <div className="history-info" role="alert">
                      {uiMessage(history.error)}
                      <ActionButton className="quiet-button" onClick={() => void refreshHistory()}>
                        {t("重新读取")}
                      </ActionButton>
                    </div>
                  )}
                  {!history.loading && !history.error && !history.items.length && (
                    <p className="history-info">{t("还没有会话，开始你的第一个问题。")}</p>
                  )}
                  {!history.loading && history.items.length < history.total && (
                    <Dropdown.Item
                      onSelect={(event) => {
                        event.preventDefault();
                        void refreshHistory(true);
                      }}
                    >
                      {t("加载更多会话")}
                    </Dropdown.Item>
                  )}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
            <ActionButton
              className="icon-button new-conversation"
              aria-label={t("新建对话")}
              disabled={creating || state.submitting}
              onClick={() => void create()}
              title={t("新建本机会话")}
            >
              {creating ? <LoaderCircle size={17} className="spin" /> : <Plus size={19} />}
            </ActionButton>
          </div>
        </div>
        <div
          className="chat-scroll"
          ref={scroll}
          onScroll={(event) => {
            const element = event.currentTarget;
            follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 90;
            setShowJump(!follow.current);
          }}
        >
          {!valid ? (
            <div className="list-state error-state" role="alert">
              <h2>{t("对话地址无效")}</h2>
              <Link href="/" className="secondary-button">
                {t("回到新的对话")}
              </Link>
            </div>
          ) : state.loading && !state.messages.length ? (
            <div className="list-state" role="status">
              <LoaderCircle className="spin" size={24} />
              <h2>{t("正在恢复原始对话")}</h2>
            </div>
          ) : !state.messages.length && !pendingVisible && !state.loadError ? (
            <div className="welcome chat-welcome">
              <div className="welcome-mark">
                <BrandMark />
              </div>
              <p className="eyebrow">{t("一个问题，一段新的联系")}</p>
              <h2>
                {t("让知识与经历，")}
                <br />
                {t("在时间里相遇。")}
              </h2>
              <p className="welcome-description">
                {t("聊聊正在想的问题，")}
                <br className="mobile-break" />
                {t("或从你的标签中找到线索。")}
              </p>
              <Link href="/tags/" className="welcome-action">
                <Tags size={17} />
                <span>{t("看看我的标签池")}</span>
                <ArrowRight size={17} />
              </Link>
              <p className="welcome-hint">{t("原始对话保存在本机 · 知识整理可在设置中选择")}</p>
            </div>
          ) : (
            <div className="chat-messages">
              {state.hasMore && (
                <ActionButton
                  className="older-button quiet-button"
                  disabled={state.olderLoading}
                  onClick={() => void older(session)}
                >
                  {state.olderLoading && <LoaderCircle size={14} className="spin" />}
                  {state.olderLoading ? t("正在读取…") : t("加载更早记录")}
                </ActionButton>
              )}
              {state.olderError && (
                <p className="inline-error" role="alert">
                  {state.olderError}
                </p>
              )}
              {state.messages.map((message) => (
                <div key={message.id}>
                  {pendingBubble && message.id === state.run?.assistant_message_id && pendingBubble}
                  <MessageBubble message={message} />
                </div>
              ))}
              {pendingBubble &&
                !state.messages.some((message) => message.id === state.run?.assistant_message_id) &&
                pendingBubble}
            </div>
          )}
          {state.loadError && (
            <div className="chat-notice error" role="alert">
              {state.loadError}
              <ActionButton className="quiet-button" onClick={() => void session.load()}>
                <RefreshCw size={13} />
                {t("重新读取记录")}
              </ActionButton>
            </div>
          )}
          {state.run?.context_truncated && (
            <p className="context-note">
              {t(
                "本轮只使用了近期上下文（最多 12 个成功轮次、约 32,000 字符），本机原始历史仍完整保留。",
              )}
            </p>
          )}
          {state.run?.error && (
            <div className="chat-notice error" role="alert">
              <strong>{t(statusLabels[state.run.status])}</strong>
              <p>{uiMessage(state.run.error.message)}</p>
              <Link href="/settings/">
                {t("查看模型设置 ")}
                <ArrowRight size={13} />
              </Link>
            </div>
          )}
        </div>
        {showJump && (
          <ActionButton
            className="jump-button"
            aria-label={t("回到最新消息")}
            onClick={() => {
              follow.current = true;
              if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
              setShowJump(false);
            }}
          >
            <ArrowDown size={16} />
          </ActionButton>
        )}
        <div className="chat-feedback">
          {createError && (
            <p className="inline-error" role="alert">
              {createError}
            </p>
          )}
          {agent.error ? (
            <div className="chat-notice error" role="alert">
              {t("无法读取模型配置：")}
              {uiMessage(agent.error)}
              <ActionButton className="quiet-button" onClick={() => void agentStore.refresh()}>
                {t("重新读取")}
              </ActionButton>
            </div>
          ) : !agent.loading && !agent.value?.configured ? (
            <div className="model-missing" role="status">
              <span>{t("云端模型尚未配置")}</span>
              <Link href="/settings/">
                {t("去设置 URL、API Key 和模型名 ")}
                <ArrowRight size={13} />
              </Link>
            </div>
          ) : null}
          {state.error && (
            <div className="chat-notice error" role="alert">
              {uiMessage(state.error)}
              <div className="recovery-actions">
                {uncertain ? (
                  <>
                    <ActionButton
                      className="quiet-button"
                      disabled={state.checking || state.submitting}
                      onClick={() => void session.checkSubmission()}
                    >
                      {t("核对本次运行")}
                    </ActionButton>
                    {pending?.status === "not_found" && (
                      <ActionButton
                        className="quiet-button"
                        disabled={state.checking || state.submitting}
                        onClick={() => void session.send(true)}
                      >
                        {t("手动重新提交原消息")}
                      </ActionButton>
                    )}
                  </>
                ) : (
                  state.run && (
                    <ActionButton
                      className="quiet-button"
                      disabled={state.checking}
                      onClick={() => void session.reconnect()}
                    >
                      {t("重新连接 / 核对状态")}
                    </ActionButton>
                  )
                )}
              </div>
            </div>
          )}
          {state.stream === "recovering" && (
            <p className="stream-note" role="status">
              {t("正在恢复实时连接，先核对本机状态…")}
            </p>
          )}
          {state.stopRequested && (
            <p className="stream-note" role="status">
              {t("停止请求已送达，等待运行实际结束。")}
            </p>
          )}
        </div>
        {session.id && (
          <details className="chat-memory" open>
            <summary>{t("知识整理 · 独立于回复生成")}</summary>
            <MemoryJobs
              conversationId={session.id}
              runId={state.run?.status === "completed" ? state.run.id : undefined}
            />
          </details>
        )}
        <div className="composer-wrap">
          <div className="stage-note">
            <Sparkles size={14} />
            <span>
              {agent.loading
                ? t("正在读取模型配置…")
                : agent.value?.configured
                  ? t("模型：{0}", [agent.value.model])
                  : t("填写你自己的云端模型")}
            </span>
            <Link className="stage-note-tail" href="/knowledge/">
              {t("前往知识宇宙")}
            </Link>
          </div>
          <form
            className="composer"
            aria-label={t("发送对话")}
            onSubmit={(event) => void send(event)}
          >
            <label htmlFor="chat-input" className="sr-only">
              {t("消息内容")}
            </label>
            <textarea
              ref={input}
              id="chat-input"
              placeholder={t("聊聊你正在想的问题…")}
              rows={2}
              value={state.draft}
              readOnly={creating || state.submitting || uncertain}
              onChange={(event) => session.setDraft(event.target.value)}
              aria-describedby={length > 20000 ? "message-limit" : "chat-save-note"}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229 &&
                  canSend
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {length > 20000 && (
              <p className="inline-error" id="message-limit" role="alert">
                {t("消息最多 20,000 个字符，当前 ")}
                {length.toLocaleString()}
                {t("个。")}
              </p>
            )}
            <div className="composer-toolbar">
              <div className="composer-tools">
                <span className="tool-chip">
                  <Tags size={14} />
                  {t("标签查询 · 只读")}
                </span>
                <span className="composer-hint" id="chat-save-note">
                  {t("Enter 发送 · Shift + Enter 换行")}
                </span>
              </div>
              <div className="send-area">
                {active ? (
                  <ActionButton
                    type="button"
                    className="stop-button"
                    aria-label={t("停止生成")}
                    disabled={state.cancelling}
                    onClick={() => void session.cancel()}
                  >
                    {state.cancelling ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <Square size={14} />
                    )}
                    <span>
                      {state.cancelling
                        ? t("正在停止…")
                        : state.stopRequested
                          ? t("再次停止")
                          : t("停止")}
                    </span>
                  </ActionButton>
                ) : (
                  <ActionButton
                    type="submit"
                    className="send-button"
                    aria-label={t("发送消息")}
                    disabled={!canSend}
                  >
                    {creating || state.submitting ? (
                      <LoaderCircle size={19} className="spin" />
                    ) : (
                      <ArrowUp size={22} />
                    )}
                  </ActionButton>
                )}
              </div>
            </div>
          </form>
        </div>
      </div>
      <Constellation />
    </WorkspaceSurface>
  );
}
