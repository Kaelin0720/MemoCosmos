import { isRecord, isUuid } from "./chat-types";
import type { NoteSummary } from "./note-types";
export const jobStatuses = [
  "pending",
  "running",
  "completed",
  "skipped",
  "needs_confirmation",
  "failed",
  "interrupted",
] as const;
export type MemoryJob = {
  id: string;
  conversation_id: string;
  run_id: string;
  user_message_id: string;
  status: (typeof jobStatuses)[number];
  reason: string;
  question: string;
  error: { code: string; message: string } | null;
  notes: { id: string; title: string; action: "created" | "updated" }[];
  created_at: string;
  updated_at: string;
};
export type MemoryHit = {
  note_id: string;
  title: string;
  folder: string;
  tags: NoteSummary["tags"];
  version: number;
  heading: string;
  excerpt: string;
  score: number;
};
export type MemoryGraph = {
  nodes: { id: string; title: string; folder: string; tags: NoteSummary["tags"] }[];
  edges: {
    id: string;
    source: string;
    target: string;
    relation: string;
    evidence: string;
    source_message_id: string | null;
    created_at: string;
  }[];
};
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const tags = (value: unknown): value is NoteSummary["tags"] =>
  Array.isArray(value) &&
  value.every((tag) => isRecord(tag) && typeof tag.id === "string" && typeof tag.name === "string");
export function parseJob(value: unknown): MemoryJob {
  if (
    !isRecord(value) ||
    !["id", "conversation_id", "run_id", "user_message_id"].every((key) => isUuid(value[key])) ||
    !jobStatuses.includes(value.status as MemoryJob["status"]) ||
    typeof value.reason !== "string" ||
    typeof value.question !== "string" ||
    !date(value.created_at) ||
    !date(value.updated_at) ||
    !Array.isArray(value.notes) ||
    !value.notes.every(
      (note) =>
        isRecord(note) &&
        isUuid(note.id) &&
        typeof note.title === "string" &&
        ["created", "updated"].includes(String(note.action)),
    ) ||
    !(
      value.error === null ||
      (isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string")
    )
  )
    throw new Error("整理任务格式不正确，请重新读取。");
  return {
    id: String(value.id),
    conversation_id: String(value.conversation_id),
    run_id: String(value.run_id),
    user_message_id: String(value.user_message_id),
    status: value.status as MemoryJob["status"],
    reason: value.reason,
    question: value.question,
    notes: value.notes.map((note) => ({ id: note.id, title: note.title, action: note.action })),
    error:
      value.error === null
        ? null
        : { code: String(value.error.code), message: String(value.error.message) },
    created_at: String(value.created_at),
    updated_at: String(value.updated_at),
  };
}
export function parseJobs(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items) || !Number.isSafeInteger(value.total))
    throw new Error("整理目录格式不正确。");
  return { items: value.items.map(parseJob), total: Number(value.total) };
}
export function parseSearch(value: unknown): {
  items: MemoryHit[];
  total: number;
  truncated: boolean;
} {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !Number.isSafeInteger(value.total) ||
    typeof value.truncated !== "boolean"
  )
    throw new Error("检索结果格式不正确。");
  const items = value.items.map((item) => {
    if (
      !isRecord(item) ||
      !isUuid(item.note_id) ||
      !["title", "folder", "heading", "excerpt"].every((key) => typeof item[key] === "string") ||
      !tags(item.tags) ||
      !Number.isSafeInteger(item.version) ||
      Number(item.version) < 1 ||
      typeof item.score !== "number" ||
      !Number.isFinite(item.score)
    )
      throw new Error("检索条目格式不正确。");
    return {
      note_id: item.note_id,
      title: String(item.title),
      folder: String(item.folder),
      heading: String(item.heading),
      excerpt: String(item.excerpt),
      tags: item.tags,
      version: Number(item.version),
      score: item.score,
    };
  });
  if (items.reduce((length, item) => length + Array.from(item.excerpt).length, 0) > 8000)
    throw new Error("检索摘录超过本批约定的预算。");
  return { items, total: Number(value.total), truncated: value.truncated };
}
export function parseGraph(value: unknown): MemoryGraph {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    value.nodes.length > 200 ||
    value.edges.length > 500
  )
    throw new Error("关系图格式不正确。");
  const nodes = value.nodes.map((node) => {
    if (
      !isRecord(node) ||
      !isUuid(node.id) ||
      typeof node.title !== "string" ||
      typeof node.folder !== "string" ||
      !tags(node.tags)
    )
      throw new Error("关系节点格式不正确。");
    return { id: node.id, title: node.title, folder: node.folder, tags: node.tags };
  });
  const edges = value.edges.map((edge) => {
    if (
      !isRecord(edge) ||
      typeof edge.id !== "string" ||
      !isUuid(edge.source) ||
      !isUuid(edge.target) ||
      typeof edge.relation !== "string" ||
      typeof edge.evidence !== "string" ||
      !(edge.source_message_id === null || isUuid(edge.source_message_id)) ||
      !date(edge.created_at)
    )
      throw new Error("关系证据格式不正确。");
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      evidence: edge.evidence,
      source_message_id: edge.source_message_id as string | null,
      created_at: String(edge.created_at),
    };
  });
  return { nodes, edges };
}
