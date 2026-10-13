export const runStatuses = [
  "pending",
  "running",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
] as const;
export type RunStatus = (typeof runStatuses)[number];
export type Conversation = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  active_run_id: string | null;
};
export type Message = {
  id: string;
  conversation_id: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  status: RunStatus;
  run_id: string;
  created_at: string;
  updated_at: string;
};
export type Run = {
  id: string;
  conversation_id: string;
  client_message_id: string;
  user_message_id: string;
  assistant_message_id: string;
  status: RunStatus;
  error: { code: string; message: string } | null;
  context_truncated: boolean;
  created_at: string;
  updated_at: string;
};
export type AgentStatus = {
  configured: boolean;
  provider: "openai" | "openai_compatible";
  model: string | null;
  base_url: string | null;
  has_api_key: boolean;
  source: "file" | "env" | "none";
  reason: string | null;
  tools: string[];
  context_max_chars: number;
  context_max_turns: number;
};
export type AgentConfig = { base_url: string; model: string; api_key?: string };
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const status = (value: unknown) => runStatuses.includes(value as RunStatus);
function invalid(): never {
  throw new Error("本机服务返回的聊天数据格式不正确，请重新读取状态。");
}

export function parseConversation(value: unknown): Conversation {
  if (
    !isRecord(value) ||
    !isUuid(value.id) ||
    typeof value.title !== "string" ||
    !date(value.created_at) ||
    !date(value.updated_at) ||
    !(value.active_run_id === null || isUuid(value.active_run_id))
  )
    invalid();
  return value as Conversation;
}
export function parseMessage(value: unknown): Message {
  if (
    !isRecord(value) ||
    !isUuid(value.id) ||
    !isUuid(value.conversation_id) ||
    !isUuid(value.run_id) ||
    !Number.isInteger(value.seq) ||
    Number(value.seq) < 1 ||
    !["user", "assistant"].includes(String(value.role)) ||
    typeof value.content !== "string" ||
    !status(value.status) ||
    !date(value.created_at) ||
    !date(value.updated_at)
  )
    invalid();
  return value as Message;
}
export function parseRun(value: unknown): Run {
  if (
    !isRecord(value) ||
    ![
      "id",
      "conversation_id",
      "client_message_id",
      "user_message_id",
      "assistant_message_id",
    ].every((key) => isUuid(value[key])) ||
    !status(value.status) ||
    typeof value.context_truncated !== "boolean" ||
    !date(value.created_at) ||
    !date(value.updated_at) ||
    !(
      value.error === null ||
      (isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string")
    )
  )
    invalid();
  return value as Run;
}
export function parseAgentStatus(value: unknown): AgentStatus {
  if (
    !isRecord(value) ||
    typeof value.configured !== "boolean" ||
    typeof value.has_api_key !== "boolean" ||
    !["openai", "openai_compatible"].includes(String(value.provider)) ||
    !["file", "env", "none"].includes(String(value.source)) ||
    !(value.reason === null || typeof value.reason === "string") ||
    !(value.model === null || typeof value.model === "string") ||
    !(value.base_url === null || typeof value.base_url === "string") ||
    !Array.isArray(value.tools) ||
    !value.tools.every((tool) => typeof tool === "string") ||
    !Number.isInteger(value.context_max_chars) ||
    Number(value.context_max_chars) <= 0 ||
    !Number.isInteger(value.context_max_turns) ||
    Number(value.context_max_turns) <= 0 ||
    (value.configured && (!value.model || !value.base_url || !value.has_api_key))
  )
    invalid();
  if (typeof value.base_url === "string") {
    try {
      const url = new URL(value.base_url);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        invalid();
    } catch {
      invalid();
    }
  }
  // Only declared, non-secret fields are retained, even if a faulty server adds extras.
  return {
    configured: value.configured,
    provider: value.provider as AgentStatus["provider"],
    model: value.model as string | null,
    base_url: value.base_url as string | null,
    has_api_key: value.has_api_key,
    source: value.source as AgentStatus["source"],
    reason: value.reason as string | null,
    tools: value.tools as string[],
    context_max_chars: Number(value.context_max_chars),
    context_max_turns: Number(value.context_max_turns),
  };
}
export function parseMessagePage(value: unknown): { items: Message[]; has_more: boolean } {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.has_more !== "boolean")
    invalid();
  return { items: value.items.map(parseMessage), has_more: value.has_more };
}
export function parseConversationPage(value: unknown): { items: Conversation[]; total: number } {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !Number.isInteger(value.total) ||
    Number(value.total) < 0
  )
    invalid();
  return { items: value.items.map(parseConversation), total: Number(value.total) };
}
export const isActive = (run: Run | null) =>
  Boolean(run && ["pending", "running"].includes(run.status));
