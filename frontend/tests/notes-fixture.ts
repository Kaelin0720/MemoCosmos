import { frontendOrigin } from "./test";
import { randomUUID } from "node:crypto";
import type { Page } from "./test";
import type { NoteDetail, NoteInput, NoteVersion, ExternalNote } from "../src/lib/note-types";
import { fixtureTag, mockApi } from "./api-fixture";

export const noteTag = {
  ...fixtureTag("Redis", "测试分类"),
  id: "12345678-1234-4234-8234-123456789abc",
};
export function fixtureNote(
  title = "Redis 缓存",
  body = "## 使用记录\n\n项目 A 已加入查询缓存。\n",
): NoteDetail {
  return {
    id: randomUUID(),
    title,
    body,
    source: "",
    folder: "",
    tags: [{ id: noteTag.id, name: noteTag.name }],
    created_at: "2026-10-10T04:00:00Z",
    updated_at: "2026-10-11T06:30:00Z",
    version: 1,
    sync_status: "synced",
    sync_error: null,
  };
}
export async function mockNotes(page: Page, seed: NoteDetail[] = []) {
  const tags = await mockApi(page, [{ ...noteTag }]);
  const state = {
    tags,
    notes: [...seed],
    inputs: [] as NoteInput[],
    posts: 0,
    listQueries: [] as string[],
    detailIds: [] as string[],
    patches: [] as (NoteInput & { expected_version: number })[],
    deletes: [] as { id: string; expected_version: number }[],
    versions: new Map<string, NoteVersion[]>(
      seed.map((note) => [note.id, [{ ...note, origin: "manual" }]]),
    ),
    external: new Map<string, ExternalNote>(),
    imports: [] as { id: string; expected_version: number; file_hash: string }[],
    loseAccepted: false,
    delaySave: 0,
    invalidTags: false,
    pendingWrite: false,
    detailDelays: new Map<string, number>(),
    brokenDetail: new Map<string, { code: string; message: string }>(),
  };
  await page.route("http://127.0.0.1:8009/api/v1/notes**", async (route) => {
    const request = route.request(),
      method = request.method(),
      url = new URL(request.url());
    const respond = (status: number, body?: unknown) =>
      route.fulfill({
        status,
        headers: {
          "Access-Control-Allow-Origin": frontendOrigin,
          "Access-Control-Allow-Headers": "Content-Type,X-Local-Token",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const error = (status: number, code: string, message: string, details = {}) =>
      respond(status, { error: { code, message, ...details } });
    if (method === "OPTIONS") return respond(204);
    if (tags.offline) return route.abort("connectionrefused");
    if (method === "POST") state.posts++;
    if (request.headers()["x-local-token"] !== tags.token)
      return error(401, "invalid_local_token", "令牌已失效");
    function current(note: NoteDetail): NoteDetail {
      return {
        ...note,
        tags: note.tags.flatMap((tag) => {
          const fresh = tags.tags.find((item) => item.id === tag.id);
          return fresh ? [{ id: fresh.id, name: fresh.name }] : [];
        }),
      };
    }
    if (method === "GET" && url.pathname === "/api/v1/notes") {
      state.listQueries.push(url.search);
      const items = state.notes
        .filter(
          (note) =>
            (!url.searchParams.get("q") || note.title.includes(url.searchParams.get("q")!)) &&
            (!url.searchParams.get("tag_id") ||
              note.tags.some((tag) => tag.id === url.searchParams.get("tag_id"))) &&
            (!url.searchParams.has("folder") || note.folder === url.searchParams.get("folder")),
        )
        .map((note) => {
          const { body, ...summary } = current(note);
          void body;
          return summary;
        });
      return respond(200, { items, total: items.length });
    }
    const segments = url.pathname.split("/");
    const id = segments[4];
    if (method === "GET" && segments[5] === "versions") {
      const items = state.versions.get(id) ?? [];
      return respond(200, { items, total: items.length });
    }
    if (method === "GET" && segments[5] === "external")
      return state.external.has(id)
        ? respond(200, state.external.get(id))
        : error(404, "note_not_found", "外部文件不存在");
    if (["PATCH", "DELETE"].includes(method) || segments[5] === "import-external") {
      const input = request.postDataJSON();
      const note = state.notes.find((note) => note.id === id);
      if (!note) return error(404, "note_not_found", "文档不存在");
      if (method === "PATCH") state.patches.push(input);
      if (input.expected_version !== note.version)
        return error(409, "note_version_conflict", "版本已变化", {
          note_id: id,
          current_version: note.version,
        });
      if (method === "DELETE") {
        state.deletes.push({ id, expected_version: input.expected_version });
        state.notes = state.notes.filter((note) => note.id !== id);
        state.versions.delete(id);
        return respond(204);
      }
      if (segments[5] === "import-external") {
        state.imports.push({ id, ...input });
        const file = state.external.get(id);
        if (!file || input.file_hash !== file.file_hash)
          return error(409, "external_note_changed", "外部文件再次变化");
        Object.assign(note, {
          title: file.title,
          body: file.body,
          version: note.version + 1,
          sync_status: "synced",
          sync_error: null,
        });
        state.brokenDetail.delete(id);
      } else {
        const captured = structuredClone(input);
        if (state.delaySave) await new Promise((resolve) => setTimeout(resolve, state.delaySave));
        Object.assign(note, {
          ...captured,
          tags: captured.tag_ids.map((id: string) => ({
            id,
            name: tags.tags.find((tag) => tag.id === id)!.name,
          })),
          version: note.version + 1,
        });
      }
      const versions = state.versions.get(id) ?? [];
      state.versions.set(id, [
        { ...note, origin: segments[5] === "import-external" ? "external" : "manual" },
        ...versions,
      ]);
      return respond(200, current(note));
    }
    if (method === "GET") {
      const id = url.pathname.split("/").at(-1)!;
      state.detailIds.push(id);
      const delay = state.detailDelays.get(id);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const broken = state.brokenDetail.get(id);
      if (broken)
        return error(409, broken.code, broken.message, { note_id: id, sync_status: "conflict" });
      const note = state.notes.find((item) => item.id === id);
      return note ? respond(200, current(note)) : error(404, "note_not_found", "文档不存在");
    }
    if (method !== "POST") return error(405, "method_not_allowed", "本批不支持编辑");
    const input = request.postDataJSON() as NoteInput;
    state.inputs.push(input);
    if (state.delaySave) await new Promise((resolve) => setTimeout(resolve, state.delaySave));
    if (state.invalidTags) {
      tags.tags = [];
      return error(422, "invalid_tag_ids", "标签已不存在");
    }
    const existing = state.notes.find(
      (note) => note.title.toLowerCase() === input.title.trim().toLowerCase(),
    );
    if (existing)
      return error(409, "note_title_exists", "标题已存在", {
        note_id: existing.id,
        secret: "must-not-retain",
      });
    const note: NoteDetail = {
      ...fixtureNote(input.title, input.body),
      source: input.source,
      folder: input.folder ?? "",
      tags: input.tag_ids.map((id) => ({ id, name: tags.tags.find((tag) => tag.id === id)!.name })),
    };
    if (state.pendingWrite) {
      Object.assign(note, {
        sync_status: "pending",
        sync_error: { code: "note_write_failed", message: "磁盘写入等待恢复", retryable: true },
      });
      state.notes.push(note);
      return error(503, "note_write_failed", "文件尚未确认", {
        note_id: note.id,
        operation_id: randomUUID(),
        sync_status: "pending",
        retryable: true,
      });
    }
    state.notes.push(note);
    state.versions.set(note.id, [{ ...note, origin: "manual" }]);
    if (state.loseAccepted) {
      state.loseAccepted = false;
      return route.abort("connectionfailed");
    }
    return respond(201, note);
  });
  return state;
}
