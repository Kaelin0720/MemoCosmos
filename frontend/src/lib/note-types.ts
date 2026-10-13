export type NoteSyncStatus = "synced" | "pending" | "conflict";
export type NoteSyncError = { code: string; message: string; retryable: boolean };
export type NoteSummary = {
  id: string;
  title: string;
  tags: { id: string; name: string }[];
  source: string;
  folder: string;
  created_at: string;
  updated_at: string;
  version: number;
  sync_status: NoteSyncStatus;
  sync_error: NoteSyncError | null;
};
export type NoteDetail = NoteSummary & { body: string };
export type NoteInput = {
  title: string;
  body: string;
  source: string;
  tag_ids: string[];
  folder?: string;
};
export type NoteVersion = {
  version: number;
  title: string;
  body: string;
  folder: string;
  source: string;
  tags: NoteSummary["tags"];
  created_at: string;
  origin: string;
};
export type ExternalNote = {
  note_id: string;
  current_version: number;
  file_hash: string;
  title: string;
  body: string;
};
export type NoteQuery = { q?: string; tag_id?: string; folder?: string };
export type NoteErrorDetails = {
  note_id?: string;
  operation_id?: string;
  current_version?: number;
  sync_status?: NoteSyncStatus;
  retryable?: boolean;
};
export const isNoteId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const syncStatus = (value: unknown): value is NoteSyncStatus =>
  value === "synced" || value === "pending" || value === "conflict";

// Pick only the documented fields. Never retain arbitrary server error payloads.
export function parseNoteError(value: unknown): NoteErrorDetails {
  if (!object(value)) return {};
  return {
    ...(isNoteId(value.note_id) ? { note_id: value.note_id } : {}),
    ...(isNoteId(value.operation_id) ? { operation_id: value.operation_id } : {}),
    ...(Number.isSafeInteger(value.current_version) && Number(value.current_version) > 0
      ? { current_version: Number(value.current_version) }
      : {}),
    ...(syncStatus(value.sync_status) ? { sync_status: value.sync_status } : {}),
    ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
  };
}
export function parseNoteSummary(value: unknown): NoteSummary {
  if (
    !object(value) ||
    !isNoteId(value.id) ||
    !(value.folder === undefined || typeof value.folder === "string") ||
    !["title", "source", "created_at", "updated_at"].every(
      (key) => typeof value[key] === "string",
    ) ||
    !Number.isFinite(Date.parse(String(value.created_at))) ||
    !Number.isFinite(Date.parse(String(value.updated_at))) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    !syncStatus(value.sync_status) ||
    !Array.isArray(value.tags) ||
    !value.tags.every(
      (tag) =>
        object(tag) &&
        typeof tag.id === "string" &&
        Boolean(tag.id) &&
        typeof tag.name === "string",
    ) ||
    !(
      value.sync_error === null ||
      (object(value.sync_error) &&
        typeof value.sync_error.code === "string" &&
        typeof value.sync_error.message === "string" &&
        typeof value.sync_error.retryable === "boolean")
    )
  ) {
    throw new Error("服务返回的文档格式不正确，请重新读取。");
  }
  return {
    id: value.id,
    title: String(value.title),
    source: String(value.source),
    folder: typeof value.folder === "string" ? value.folder : "",
    created_at: String(value.created_at),
    updated_at: String(value.updated_at),
    version: Number(value.version),
    tags: value.tags.map((tag) => ({ id: tag.id as string, name: tag.name as string })),
    sync_status: value.sync_status,
    sync_error:
      value.sync_error === null
        ? null
        : {
            code: value.sync_error.code as string,
            message: value.sync_error.message as string,
            retryable: value.sync_error.retryable as boolean,
          },
  };
}
export function parseNoteDetail(value: unknown): NoteDetail {
  const summary = parseNoteSummary(value);
  if (!object(value) || typeof value.body !== "string")
    throw new Error("服务未返回文档正文，请重新读取。");
  return { ...summary, body: value.body };
}
export function parseNoteList(value: unknown): { items: NoteSummary[]; total: number } {
  if (
    !object(value) ||
    !Array.isArray(value.items) ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < 0
  )
    throw new Error("服务返回的文档目录格式不正确，请重新读取。");
  return { items: value.items.map(parseNoteSummary), total: Number(value.total) };
}
export const textLength = (value: string) => Array.from(value).length;
function validText(value: string) {
  if (value.includes("\0")) return false;
  // Iteration pairs valid surrogates; an isolated UTF-16 surrogate cannot encode as UTF-8.
  return Array.from(value).every((char) => {
    const code = char.codePointAt(0)!;
    return code < 0xd800 || code > 0xdfff;
  });
}
export function validateFolder(folder: string): string | null {
  if (folder === "") return null;
  const segments = folder.split("/");
  if (
    textLength(folder) > 240 ||
    segments.length > 8 ||
    /[\\\u0000-\u001f\u007f-\u009f]/.test(folder) ||
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || textLength(segment) > 80,
    )
  )
    return "目录最多 8 层、240 字，每层 1–80 字；不能包含空层、点路径或反斜杠。";
  return null;
}
export function validateNote(
  input: NoteInput,
  availableIds: Set<string>,
  editing = false,
): string | null {
  const title = input.title.trim();
  if (!title || textLength(title) > 200 || /[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]/.test(title))
    return "标题需要是 1–200 字的单行文字。";
  if (textLength(input.body) > 200000) return "正文最多 200000 字，请缩短后再保存。";
  if (textLength(input.source) > 2000) return "出处最多 2000 字。";
  if (![input.title, input.body, input.source, input.folder ?? ""].every(validText))
    return "文字中含有无效字符，请移除后再保存。";
  const folderError = validateFolder(input.folder ?? "");
  if (folderError) return folderError;
  if ((!editing && !input.tag_ids.length) || input.tag_ids.length > 64)
    return "请至少选择一个已有标签，最多选择 64 个。";
  if (
    new Set(input.tag_ids).size !== input.tag_ids.length ||
    input.tag_ids.some((id) => !availableIds.has(id))
  )
    return "所选标签已失效，请移除并重新选择。";
  return null;
}
export function parseVersions(value: unknown): { items: NoteVersion[]; total: number } {
  if (!object(value) || !Array.isArray(value.items) || !Number.isSafeInteger(value.total))
    throw new Error("版本记录格式不正确。");
  return {
    items: value.items.map((item) => {
      if (
        !object(item) ||
        !Number.isSafeInteger(item.version) ||
        Number(item.version) < 1 ||
        !["title", "body", "source", "folder", "origin", "created_at"].every(
          (key) => typeof item[key] === "string",
        ) ||
        !Number.isFinite(Date.parse(String(item.created_at))) ||
        !Array.isArray(item.tags) ||
        !item.tags.every(
          (tag) => object(tag) && typeof tag.id === "string" && typeof tag.name === "string",
        )
      )
        throw new Error("版本记录格式不正确。");
      return {
        version: Number(item.version),
        title: String(item.title),
        body: String(item.body),
        source: String(item.source),
        folder: String(item.folder),
        origin: String(item.origin),
        created_at: String(item.created_at),
        tags: item.tags.map((tag) => ({ id: String(tag.id), name: String(tag.name) })),
      };
    }),
    total: Number(value.total),
  };
}
export function parseExternal(value: unknown): ExternalNote {
  if (
    !object(value) ||
    !isNoteId(value.note_id) ||
    !Number.isSafeInteger(value.current_version) ||
    Number(value.current_version) < 1 ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    typeof value.file_hash !== "string" ||
    !/^[\da-f]{64}$/i.test(value.file_hash)
  )
    throw new Error("外部文档对比格式不正确。");
  return {
    note_id: value.note_id,
    current_version: Number(value.current_version),
    file_hash: value.file_hash,
    title: value.title,
    body: value.body,
  };
}
