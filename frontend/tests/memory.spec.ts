import { PRODUCT_SLUG } from "../src/lib/product";
import { test, expect, type Page } from "./test";
import { fixtureNote, mockNotes, noteTag } from "./notes-fixture";
import { fixtureJob, mockMemory } from "./memory-fixture";
import { parseGraph, parseJobs, parseSearch } from "../src/lib/memory-types";
async function edit(page: Page) {
  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
}
const body = (page: Page) => page.locator("#note-body");
const notice = (page: Page) => page.locator(".note-notice");

test("编辑使用真实版本，解除标签和调整目录；保存过程中继续写后可再次保存", async ({ page }) => {
  const note = fixtureNote();
  const state = await mockNotes(page, [note]);
  state.delaySave = 500;
  await page.goto(`/knowledge/?note=${note.id}`);
  await edit(page);
  await page.locator("#note-folder").fill("项目/缓存");
  await page.getByRole("checkbox", { name: "Redis", exact: true }).uncheck();
  await body(page).fill("第一轮人工修改");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await body(page).fill("第一轮人工修改\n继续补充的新文字");
  await expect(notice(page)).toContainText("当前新修改仍在草稿中");
  await expect(body(page)).toHaveValue(/继续补充/);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.locator(".note-reader")).toContainText("继续补充的新文字");
  expect(state.patches.map((input) => input.expected_version)).toEqual([1, 2]);
  expect(state.notes[0].version).toBe(3);
  expect(state.notes[0].folder).toBe("项目/缓存");
  expect(state.notes[0].tags).toEqual([]);
});

test("版本冲突保留旧稿，明确对照最新内容建立合并草稿，多份草稿可切回", async ({ page }) => {
  const note = fixtureNote("缓存", "旧确认正文");
  const state = await mockNotes(page, [note]);
  await page.goto(`/knowledge/?note=${note.id}`);
  await edit(page);
  await body(page).fill("尚未保存的旧稿");
  Object.assign(state.notes[0], { version: 2, body: "另一次修改的最新正文" });
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(notice(page)).toContainText("版本已变化");
  await expect(body(page)).toHaveValue("尚未保存的旧稿");
  await page.getByRole("button", { name: "对照最新版本合并", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "对照最新版本合并" });
  await expect(dialog).toContainText("尚未保存的旧稿");
  await expect(page.locator("#merge-body")).toHaveValue("另一次修改的最新正文");
  await expect(dialog.getByRole("button", { name: "建立合并草稿" })).toBeDisabled();
  await page.locator("#merge-body").fill("另一次修改的最新正文\n已对比合并旧稿");
  await dialog.getByRole("checkbox", { name: "我已对照，使用右侧内容替换这份旧草稿" }).check();
  await dialog.getByRole("button", { name: "建立合并草稿" }).click();
  expect(state.patches).toHaveLength(1);
  await page.getByRole("button", { name: "新建文档", exact: true }).click();
  await page.locator("#note-title").fill("另一份新草稿");
  await page.getByRole("button", { name: "继续草稿", exact: true }).click();
  await page
    .getByRole("dialog", { name: "继续哪份草稿？" })
    .getByRole("button", { name: /缓存 编辑草稿/ })
    .click();
  await expect(body(page)).toHaveValue(/已对比合并/);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.locator(".note-reader")).toContainText("已对比合并");
  expect(state.patches.at(-1)?.expected_version).toBe(2);
  await page.getByRole("button", { name: "继续草稿", exact: true }).click();
  await expect(page.locator("#note-title")).toHaveValue("另一份新草稿");
});

test("历史恢复为当前版本草稿，再明确删除笔记及版本", async ({ page }) => {
  const note = fixtureNote("历史主题", "当前人工正文");
  note.version = 2;
  const state = await mockNotes(page, [note]);
  state.versions.set(note.id, [
    { ...note, origin: "manual" },
    { ...note, version: 1, body: "历史第一稿", origin: "manual" },
  ]);
  await page.goto(`/knowledge/?note=${note.id}`);
  await page.getByRole("button", { name: "版本记录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "版本记录" });
  await dialog.getByRole("button", { name: /版本 1/ }).click();
  await expect(dialog).toContainText("历史第一稿");
  await dialog.getByRole("button", { name: "作为编辑草稿" }).click();
  await expect(body(page)).toHaveValue("历史第一稿");
  expect(state.patches).toHaveLength(0);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.locator(".note-reader")).toContainText("版本 3");
  await page.getByRole("button", { name: "删除笔记", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("原始聊天独立保留");
  expect(state.deletes).toHaveLength(0);
  await page.getByRole("button", { name: "确认删除笔记", exact: true }).click();
  await expect(notice(page)).toContainText("笔记与版本已删除");
  expect(state.deletes).toEqual([{ id: note.id, expected_version: 3 }]);
  expect(state.notes).toHaveLength(0);
});

test("外部文件先对比，hash变化拒绝后重新对比，旧编辑草稿仍保留", async ({ page }) => {
  const note = fixtureNote("外部主题", "最后确认的文字");
  const state = await mockNotes(page, [note]);
  await page.goto(`/knowledge/?note=${note.id}`);
  await edit(page);
  await body(page).fill("我的未保存草稿");
  state.brokenDetail.set(note.id, { code: "external_note_changed", message: "外部文件已变化" });
  state.external.set(note.id, {
    note_id: note.id,
    current_version: 1,
    file_hash: "a".repeat(64),
    title: "外部主题",
    body: "第一次外部改动",
  });
  await page.locator(".note-entry").click();
  await page.getByRole("button", { name: "对比外部修改", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "外部文件对比" });
  await expect(dialog).toContainText("最后确认的文字");
  await expect(dialog).toContainText("第一次外部改动");
  await expect(dialog.getByRole("button", { name: "确认导入外部修改" })).toBeDisabled();
  state.external.set(note.id, {
    ...state.external.get(note.id)!,
    file_hash: "b".repeat(64),
    body: "第二次外部改动",
  });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "确认导入外部修改" }).click();
  await expect(dialog.getByRole("alert")).toContainText("再次变化");
  expect(state.imports).toHaveLength(1);
  await dialog.getByRole("button", { name: "重新对比" }).click();
  await expect(dialog).toContainText("第二次外部改动");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "确认导入外部修改" }).click();
  await expect(page.locator(".note-reader")).toContainText("第二次外部改动");
  await page.getByRole("button", { name: "返回草稿" }).click();
  await expect(body(page)).toHaveValue("我的未保存草稿");
  expect(state.imports.at(-1)?.file_hash).toBe("b".repeat(64));
});

test("逻辑目录、标题标签交集、章节检索和文档高亮链接", async ({ page }) => {
  const first = fixtureNote("Redis 缓存", "## 使用记录\n\n查询缓存有效");
  first.folder = "知识/数据库";
  const second = fixtureNote(
    "项目 A",
    `#### 实验结果\n\n[## Redis 缓存](./${first.id}.md#使用记录)`,
  );
  second.folder = "项目/缓存";
  const state = await mockNotes(page, [first, second]);
  const memory = await mockMemory(page);
  memory.hits = [
    {
      note_id: first.id,
      title: first.title,
      folder: first.folder,
      tags: first.tags,
      version: 1,
      heading: "使用记录",
      excerpt: "查询缓存有效",
      score: 3,
    },
  ];
  await page.goto(`/knowledge/?note=${second.id}`);
  await page.getByRole("link", { name: "Redis 缓存", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`note=${first.id}`));
  await expect(page.locator("#使用记录")).toBeVisible();
  await page.locator("#note-title-search").fill("Redis");
  await page.locator("#note-tag-filter").selectOption(noteTag.id);
  await expect(page.locator(".note-entry")).toHaveCount(1);
  expect(
    state.listQueries.some((query) => query.includes("q=Redis") && query.includes("tag_id=")),
  ).toBe(true);
  await expect(page.getByRole("button", { name: "目录 知识", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByRole("button", { name: "目录 数据库", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.getByRole("button", { name: "只看目录 数据库", exact: true }).click();
  await expect
    .poll(() =>
      state.listQueries.some((query) => decodeURIComponent(query).includes("folder=知识/数据库")),
    )
    .toBe(true);
  await page.getByText("章节与正文检索", { exact: true }).click();
  await page.locator("#memory-query").fill("缓存");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await page.locator(".memory-hit").click();
  await expect(page.locator("#使用记录")).toBeVisible();
  expect(memory.searches[0]).toContain("tag_ids=");
});

test("关联文档跨筛选跳转、选中目录和浏览器返回，保留未保存草稿", async ({ page }) => {
  const first = fixtureNote("Redis 缓存", "缓存的知识记录");
  first.folder = "知识/数据库";
  const second = fixtureNote("项目 A", `[## Redis 缓存](./${first.id}.md)`);
  second.folder = "项目/缓存";
  const state = await mockNotes(page, [first, second]);
  const memory = await mockMemory(page);
  memory.graph = {
    nodes: [first, second],
    edges: [
      {
        id: "cross-folder-link",
        source: first.id,
        target: second.id,
        relation: "应用",
        evidence: "项目 A 使用查询缓存",
        source_message_id: null,
        created_at: first.created_at,
      },
    ],
  };
  await page.goto(`/knowledge/?note=${first.id}`);
  await expect(page.locator(".note-reader h2")).toHaveText(first.title);
  await page.locator("#note-title-search").fill("Redis");
  await page.getByRole("button", { name: "只看目录 数据库", exact: true }).click();
  await expect(page.locator(".note-entry")).toHaveCount(1);
  await page
    .locator(".note-relations")
    .getByRole("link", { name: second.title, exact: true })
    .click();
  await expect(page.locator(".note-reader h2")).toHaveText(second.title);
  await expect(page.locator(".note-entry[aria-current='page']")).toHaveText(second.title);
  await expect(page.getByRole("button", { name: "目录 项目", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator("#note-title-search")).toHaveValue("");
  await page
    .locator(".note-reader .chat-markdown")
    .getByRole("link", { name: first.title, exact: true })
    .click();
  await expect(page.locator(".note-reader h2")).toHaveText(first.title);
  await page.goBack();
  await expect(page.locator(".note-reader h2")).toHaveText(second.title);
  await expect(page.locator(".note-entry[aria-current='page']")).toHaveText(second.title);
  await edit(page);
  await body(page).fill("跨文档跳转前尚未保存的修改");
  await page.locator(".note-entry").filter({ hasText: first.title }).click();
  await expect(page.locator(".note-reader h2")).toHaveText(first.title);
  await page.getByRole("button", { name: "继续草稿", exact: true }).click();
  await expect(body(page)).toHaveValue("跨文档跳转前尚未保存的修改");
  expect(state.patches).toHaveLength(0);
});

test("星图选择、证据、键盘移动、拖拽、缩放和减少动画", async ({ page }) => {
  const first = fixtureNote(),
    second = fixtureNote("项目 A");
  await mockNotes(page, [first, second]);
  const memory = await mockMemory(page);
  memory.graph = {
    nodes: [first, second],
    edges: [
      {
        id: "relation-1",
        source: first.id,
        target: second.id,
        relation: "应用",
        evidence: "已确认版本 1：项目 A 使用 Redis 缓存",
        source_message_id: null,
        created_at: first.created_at,
      },
    ],
  };
  await page.goto("/knowledge/");
  await page.getByRole("button", { name: "关系星图", exact: true }).click();
  const node = page.getByRole("button", { name: "选择节点 Redis 缓存", exact: true });
  await node.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "应用 · 项目 A", exact: true }).click();
  await expect(page.locator(".graph-evidence")).toContainText("已确认版本 1");
  const before = await node.getAttribute("transform");
  await node.focus();
  await page.keyboard.press("ArrowRight");
  await expect(node).not.toHaveAttribute("transform", before!);
  const box = await node.locator(".graph-core").boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 45, box!.y + box!.height / 2 + 30, { steps: 3 });
  await page.mouse.up();
  await expect(node).not.toHaveAttribute("transform", before!);
  await page.getByRole("button", { name: "放大星图" }).click();
  await expect(page.locator(".graph-network")).toHaveAttribute("transform", /scale\(1\.15\)/);
  await page.getByRole("button", { name: "复位星图" }).click();
  await expect(page.locator(".graph-network")).toHaveAttribute("transform", /scale\(1\)/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".memory-graph animateMotion")).toHaveCount(0);
  await page.getByRole("button", { name: "打开文档", exact: true }).click();
  await expect(page.locator(".note-reader")).toContainText("Redis 缓存");
});

test("整理待确认澄清、跳过、显式重试和页面隐藏暂停轮询", async ({ page }) => {
  await mockNotes(page);
  const memory = await mockMemory(page);
  const confirm = fixtureJob("needs_confirmation"),
    failed = fixtureJob("failed"),
    running = fixtureJob("running");
  memory.jobs = [confirm, failed, running];
  await page.goto("/knowledge/");
  await page.getByRole("button", { name: "整理与确认", exact: true }).click();
  await page.getByLabel("补充澄清（选填）").fill("这是同事的计划，还没有完成");
  await page.getByRole("button", { name: "提交澄清", exact: true }).click();
  await expect.poll(() => memory.actions.length).toBe(1);
  expect(memory.actions[0].input).toEqual({
    action: "confirm",
    clarification: "这是同事的计划，还没有完成",
  });
  await page.getByRole("button", { name: "重新整理", exact: true }).click();
  await expect.poll(() => memory.actions.length).toBe(2);
  await expect(page.locator(".memory-job.running")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const reads = memory.reads;
  await page.waitForTimeout(2300);
  expect(memory.reads).toBe(reads);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => memory.reads).toBeGreaterThan(reads);
  memory.jobs = [fixtureJob("needs_confirmation")];
  await page.getByRole("button", { name: "刷新整理任务" }).click();
  await page.getByRole("button", { name: "跳过这次整理" }).click();
  await expect.poll(() => memory.actions.at(-1)?.input.action).toBe("dismiss");
});

test("整理设置真实响应、ZIP下载、octet-stream恢复与未知结果不自动重发", async ({ page }) => {
  await mockNotes(page);
  const memory = await mockMemory(page);
  await page.goto("/settings/");
  const toggle = page.getByRole("switch", { name: "自动整理", exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(memory.settingsWrites).toBe(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出记忆 ZIP" }).click();
  expect((await download).suggestedFilename()).toMatch(
    new RegExp(`${PRODUCT_SLUG}-memory-.*\\.zip`),
  );
  const zip = Buffer.from([80, 75, 3, 4, 8, 7, 6]);
  await page
    .locator("#memory-zip")
    .setInputFiles({ name: "preview.zip", mimeType: "application/zip", buffer: zip });
  await page.getByRole("button", { name: "恢复到新库", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /确认恢复/ }).click();
  await expect(page.locator(".memory-restored")).toContainText("/tmp/只读测试恢复目录");
  await expect(page.locator(".memory-restored")).toContainText(
    "python run.py --memory-dir <恢复目录>",
  );
  expect(memory.imports[0].type).toBe("application/octet-stream");
  expect(memory.imports[0].body).toEqual(zip);
  memory.importUnknown = true;
  await page
    .locator("#memory-zip")
    .setInputFiles({ name: "unknown.zip", mimeType: "application/zip", buffer: zip });
  await page.getByRole("button", { name: "恢复到新库", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /确认恢复/ })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("恢复结果未确认");
  expect(memory.imports).toHaveLength(2);
});

test("真实空库无预置文档或示例，手机目录开关和减少动画可用", async ({ page }) => {
  const state = await mockNotes(page);
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/knowledge/");
  await expect(page.getByText("还没有主题文档")).toBeVisible();
  await expect(page.getByText(/只读示例|演示/)).toHaveCount(0);
  await page.getByRole("button", { name: "收起目录", exact: true }).click();
  await expect(page.getByRole("button", { name: "展开目录", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "展开目录", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(state.notes).toEqual([]);
  expect(state.posts).toBe(0);
});

test("记忆协议拒绝超额摘录与未知状态，过滤不公开的字段", () => {
  const job = fixtureJob("completed");
  expect(parseJobs({ items: [{ ...job, plan: "private" }], total: 1 }).items[0]).not.toHaveProperty(
    "plan",
  );
  expect(() => parseJobs({ items: [{ ...job, status: "made_up" }], total: 1 })).toThrow();
  const note = fixtureNote();
  expect(() =>
    parseSearch({
      items: [
        {
          note_id: note.id,
          title: note.title,
          folder: "",
          tags: note.tags,
          version: 1,
          heading: "",
          excerpt: "字".repeat(8001),
          score: 1,
        },
      ],
      total: 1,
      truncated: false,
    }),
  ).toThrow(/预算/);
  expect(() => parseGraph({ nodes: [{ ...note, id: "../file" }], edges: [] })).toThrow();
});
