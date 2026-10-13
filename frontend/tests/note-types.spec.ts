import { test, expect } from "./test";
import { parseNoteError, parseNoteList, validateNote } from "../src/lib/note-types";
import { fixtureNote, noteTag } from "./notes-fixture";

test("文档接口边界：错误元数据兼容 code/message，目录不保留意外全文，版本与状态严格校验", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  expect(parseNoteError({ code: "old_error", message: "旧错误" })).toEqual({});
  expect(
    parseNoteError({
      note_id: id,
      operation_id: id,
      current_version: 3,
      sync_status: "pending",
      retryable: false,
      secret: "never-retain",
    }),
  ).toEqual({
    note_id: id,
    operation_id: id,
    current_version: 3,
    sync_status: "pending",
    retryable: false,
  });
  expect(
    parseNoteError({
      note_id: "../../arbitrary-file",
      operation_id: 7,
      current_version: "3",
      sync_status: "complete",
      retryable: "yes",
    }),
  ).toEqual({});
  const note = fixtureNote();
  expect(parseNoteList({ items: [note], total: 1 }).items[0]).not.toHaveProperty("body");
  expect(() =>
    parseNoteList({ items: [{ ...note, sync_status: "complete" }], total: 1 }),
  ).toThrow();
  expect(() => parseNoteList({ items: [{ ...note, version: 0 }], total: 1 })).toThrow();
});

test("创建校验使用 Unicode 字符长度，保留空正文并拒绝无效文本和失效标签", () => {
  const input = { title: "星".repeat(200), body: "", source: "", tag_ids: [noteTag.id] };
  const ids = new Set(input.tag_ids);
  expect(validateNote({ ...input, title: "🌌".repeat(200) }, ids)).toBeNull();
  expect(validateNote({ ...input, title: "🌌".repeat(201) }, ids)).toContain("200");
  expect(validateNote({ ...input, body: "\ud800" }, ids)).toContain("无效字符");
  expect(validateNote({ ...input, source: "\0" }, ids)).toContain("无效字符");
  expect(validateNote({ ...input, title: "第一行\u2028第二行" }, ids)).toContain("单行");
  expect(validateNote(input, new Set())).toContain("失效");
});
