import { test, expect, type Page } from "./test";
import { fixtureNote, mockNotes } from "./notes-fixture";
test.use({ timezoneId: "Asia/Shanghai" });

async function writeDraft(
  page: Page,
  title = "缓存穿透",
  body = "  ## 待理解\n\n先确认问题，再记录实验。\n  ",
) {
  await page.getByRole("button", { name: "新建文档", exact: true }).click();
  await page.locator("#note-title").fill(title);
  await page.getByRole("checkbox", { name: "Redis", exact: true }).check();
  await page.getByLabel("Markdown 正文", { exact: false }).fill(body);
}
async function space(page: Page, name: string) {
  await page.getByRole("button", { name: /切换空间/ }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function warns(page: Page) {
  return page.evaluate(
    () => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  );
}

test("真实空目录、必填标签与标题校验，没有预置演示笔记", async ({ page }) => {
  const state = await mockNotes(page);
  await page.goto("/knowledge/");
  await expect(page.getByText("还没有主题文档")).toBeVisible();
  await page.getByRole("button", { name: "新建文档", exact: true }).click();
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.locator(".note-notice[role=alert]")).toContainText("单行文字");
  await page.locator("#note-title").fill("新主题");
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.locator(".note-notice[role=alert]")).toContainText("至少选择一个");
  expect(state.posts).toBe(0);
  expect(state.listQueries.every((query) => query === "")).toBe(true);
});

test("创建 201 才保存，正文空白和出处保持，目录摘要、全文与本机日期分开", async ({ page }) => {
  const state = await mockNotes(page);
  await page.goto("/knowledge/");
  await writeDraft(page);
  await page.getByLabel("出处", { exact: false }).fill("  https://example.org/source  ");
  await page.getByRole("button", { name: "保存文档", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".note-notice[role=status]")).toContainText("已保存「缓存穿透」");
  await expect(page).toHaveURL(/note=[\da-f-]+/);
  await expect(page.getByRole("article", { name: "文档原文" })).toContainText("先确认问题");
  expect(state.inputs[0].body).toBe("  ## 待理解\n\n先确认问题，再记录实验。\n  ");
  expect(state.inputs[0].source).toBe("  https://example.org/source  ");
  await expect(page.locator(".note-reader time").first()).toHaveAttribute(
    "datetime",
    "2026-10-10T04:00:00Z",
  );
  const displayed = await page.evaluate(() =>
    new Intl.DateTimeFormat(document.documentElement.lang, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date("2026-10-10T04:00:00Z")),
  );
  await expect(page.locator(".note-reader time").first()).toHaveText(displayed);
  await expect(page.locator(".notes-directory")).not.toContainText("先确认问题");
  expect(await warns(page)).toBe(false);
  expect(state.posts).toBe(1);
});

test("同标题 409 按已有 ID 打开原文，新稿保留且不追加", async ({ page }) => {
  const original = fixtureNote("缓存穿透", "原文保持不变");
  const state = await mockNotes(page, [original]);
  await page.goto("/knowledge/");
  await writeDraft(page);
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.locator(".note-notice[role=alert]")).toContainText("同标题文档已存在");
  await page.getByRole("button", { name: "打开原文", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`note=${original.id}`));
  await expect(page.getByRole("article", { name: "文档原文" })).toContainText("原文保持不变");
  await page.getByRole("button", { name: "返回草稿" }).click();
  await expect(page.getByLabel("Markdown 正文", { exact: false })).toHaveValue(/先确认问题/);
  expect(state.notes).toHaveLength(1);
  expect(state.notes[0].body).toBe("原文保持不变");
  expect(state.posts).toBe(1);
});

test("保存中的新输入不会被旧成功响应清空", async ({ page }) => {
  const state = await mockNotes(page);
  state.delaySave = 900;
  await page.goto("/knowledge/");
  await writeDraft(page);
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.getByRole("button", { name: "正在保存…" })).toBeDisabled();
  await page.getByLabel("Markdown 正文", { exact: false }).fill("正在继续写的新内容");
  await expect(page.locator(".note-notice[role=status]")).toContainText("当前新修改仍在草稿中");
  await expect(page.getByLabel("Markdown 正文", { exact: false })).toHaveValue(
    "正在继续写的新内容",
  );
  expect(state.inputs[0].body).not.toBe("正在继续写的新内容");
  expect(await warns(page)).toBe(true);
  expect(state.posts).toBe(1);
});

test("响应丢失保留未知结果，读取同标题原文也不认定本次已保存或自动重发", async ({ page }) => {
  const state = await mockNotes(page);
  state.loseAccepted = true;
  await page.goto("/knowledge/");
  await writeDraft(page);
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.locator(".note-notice[role=alert]")).toContainText("保存结果未确认");
  await page.getByRole("button", { name: "读取目录核对" }).click();
  await page.locator(".note-entry").filter({ hasText: "缓存穿透" }).click();
  await expect(page.getByRole("article", { name: "文档原文" })).toBeVisible();
  await expect(page.locator(".note-notice[role=alert]")).toContainText("保存结果未确认");
  await page.getByRole("button", { name: "返回草稿" }).click();
  await expect(page.locator("#note-title")).toHaveValue("缓存穿透");
  expect(state.posts).toBe(1);
});

test("草稿跨标签池和工作台保留，新标签可选择，离页提醒由稳定外壳负责", async ({ page }) => {
  await mockNotes(page);
  await page.goto("/knowledge/");
  await writeDraft(page);
  await page.getByRole("link", { name: "去标签池新建" }).click();
  expect(await warns(page)).toBe(true);
  await page.getByRole("button", { name: "新增标签", exact: true }).click();
  await page.getByLabel("标签名称").fill("学习记录");
  await page.getByRole("button", { name: "保存标签", exact: true }).click();
  await space(page, "工作台");
  expect(await warns(page)).toBe(true);
  await space(page, "知识宇宙");
  await expect(page.locator("#note-title")).toHaveValue("缓存穿透");
  await expect(page.getByRole("checkbox", { name: "学习记录" })).toBeVisible();
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain("缓存穿透");
  await page.getByRole("button", { name: "清空草稿", exact: true }).click();
  await page.getByRole("button", { name: "确认清空草稿" }).click();
  expect(await warns(page)).toBe(false);
});

test("提交时标签已删除：保留输入，反馈失效分类并要求重选", async ({ page }) => {
  const state = await mockNotes(page);
  state.invalidTags = true;
  await page.goto("/knowledge/");
  await writeDraft(page);
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.locator(".note-tag-picker [role=alert]")).toContainText("所选标签已失效");
  await expect(page.getByLabel("Markdown 正文", { exact: false })).toHaveValue(/先确认问题/);
  await page.getByRole("button", { name: "移除失效标签" }).click();
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.locator(".note-notice")).toContainText("至少选择一个");
  expect(state.posts).toBe(1);
});

test("同步未完成和冲突条目显示原因，不以快照正文冒充全文", async ({ page }) => {
  const pending = fixtureNote("未完成文档", "不能作为已保存全文显示");
  pending.sync_status = "pending";
  pending.sync_error = { code: "note_write_failed", message: "磁盘等待恢复", retryable: true };
  const conflict = fixtureNote("外部变化", "旧快照不展示");
  conflict.sync_status = "conflict";
  conflict.sync_error = {
    code: "external_note_changed",
    message: "外部文件已变化",
    retryable: false,
  };
  const state = await mockNotes(page, [pending, conflict]);
  state.brokenDetail.set(conflict.id, { code: "external_note_changed", message: "外部文件已变化" });
  await page.goto("/knowledge/");
  await expect(page.locator(".notes-directory")).toContainText("同步未完成");
  await expect(page.locator(".notes-directory")).toContainText("磁盘等待恢复");
  await page.locator(".note-entry").filter({ hasText: "未完成文档" }).click();
  await expect(page.locator(".notes-document [role=alert]")).toContainText("磁盘等待恢复");
  await expect(page.locator(".notes-document")).not.toContainText("不能作为已保存全文显示");
  await page.locator(".note-entry").filter({ hasText: "外部变化" }).click();
  await expect(page.locator(".notes-document [role=alert]")).toContainText("外部文件已变化");
  await expect(page.getByRole("article", { name: "文档原文" })).toHaveCount(0);
});

test("503 保留 note_id 与同步状态供读取恢复，不能说已保存", async ({ page }) => {
  const state = await mockNotes(page);
  state.pendingWrite = true;
  await page.goto("/knowledge/");
  await writeDraft(page);
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.locator(".note-notice[role=alert]")).toContainText("保存结果未确认");
  await expect(page.locator(".note-notice[role=alert]")).toContainText("同步状态：未完成");
  await page.getByRole("button", { name: "打开原文", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`note=${state.notes[0].id}`));
  await page.getByRole("button", { name: "返回草稿" }).click();
  await expect(page.locator("#note-title")).toHaveValue("缓存穿透");
  expect(state.posts).toBe(1);
});

test("标签改名刷新真实名称，最后一个标签删除只变为未分类", async ({ page }) => {
  const note = fixtureNote();
  const state = await mockNotes(page, [note]);
  await page.goto(`/knowledge/?note=${note.id}`);
  await expect(page.getByRole("article", { name: "文档原文" })).toContainText("Redis");
  state.tags.tags[0].name = "缓存";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("article", { name: "文档原文" })).toContainText("缓存");
  state.tags.tags = [];
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator(".note-reader .note-tags")).toHaveText("未分类");
  await expect(page.getByRole("article", { name: "文档原文" })).toContainText(
    "项目 A 已加入查询缓存",
  );
  expect(state.notes).toHaveLength(1);
  expect(state.posts).toBe(0);
});

test("仅明确的 401 恢复令牌并重试一次", async ({ page }) => {
  const state = await mockNotes(page);
  await page.goto("/knowledge/");
  await writeDraft(page);
  state.tags.token = "renewed-test-token";
  await page.getByRole("button", { name: "保存文档", exact: true }).click();
  await expect(page.locator(".note-notice")).toContainText("已保存「缓存穿透」");
  expect(state.posts).toBe(2);
  expect(state.notes).toHaveLength(1);
  expect(state.tags.bootstrapCalls).toBe(2);
});

test("慢详情不覆盖新选择；后退与无效地址状态准确", async ({ page }) => {
  const first = fixtureNote("第一篇", "慢的旧内容"),
    second = fixtureNote("第二篇", "新的当前内容");
  const state = await mockNotes(page, [first, second]);
  state.detailDelays.set(first.id, 700);
  await page.goto("/knowledge/");
  await page.locator(".note-entry").filter({ hasText: "第一篇" }).click();
  await page.locator(".note-entry").filter({ hasText: "第二篇" }).click();
  await expect(page.locator(".note-reader")).toContainText("新的当前内容");
  await expect.poll(() => state.detailIds.includes(second.id)).toBe(true);
  await page.goBack();
  await expect(page.locator(".note-reader")).toContainText("慢的旧内容");
  await page.goto("/knowledge/?note=../../etc/passwd");
  await expect(page.locator(".notes-document [role=alert]")).toContainText("文档地址无效");
  expect(state.detailIds.every((id) => !id.includes("passwd"))).toBe(true);
});

test("离线目录有错误而非假空白，回连不自动提交草稿", async ({ page }) => {
  const state = await mockNotes(page);
  await page.goto("/knowledge/");
  await writeDraft(page);
  state.tags.offline = true;
  await page.getByRole("button", { name: "刷新目录" }).click();
  await expect(page.locator(".notes-directory [role=alert]")).toContainText("无法连接");
  await expect(page.getByText("还没有主题文档")).toHaveCount(0);
  await expect(page.locator("#note-title")).toHaveValue("缓存穿透");
  state.tags.offline = false;
  await page.getByRole("button", { name: "刷新目录" }).click();
  await expect(page.getByText("还没有主题文档")).toBeVisible();
  expect(state.posts).toBe(0);
});

test("手机安全 Markdown：HTML、危险URL和图片不执行，代码表格自身滚动且键盘可用", async ({
  page,
}) => {
  const body = `# 正常一级标题\n\n<script>window.compromised=true</script>\n\n[危险](javascript:alert(1)) [# 关联标题](./abc.md) [外部资料](https://example.org/guide)\n\n![远程图片](https://example.invalid/track.png)\n\n\`\`\`txt\n${"很长的代码".repeat(100)}\n\`\`\`\n\n| ${"表头".repeat(30)} | 记录 |\n| --- | --- |\n| ${"文本".repeat(80)} | 内容 |`;
  const note = fixtureNote("移动端文档", body);
  await mockNotes(page, [note]);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("track.png")) requests.push(request.url());
  });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto(`/knowledge/?note=${note.id}`);
  await expect(page.getByRole("heading", { name: "正常一级标题" })).toBeVisible();
  await expect(page.locator(".note-reader script, .note-reader img")).toHaveCount(0);
  await expect(page.locator(".note-reader a")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "外部资料" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  await expect(page.getByText("关联标题", { exact: true })).toHaveAttribute(
    "title",
    /有效的文档 ID/,
  );
  const table = page.getByLabel("表格，可横向滚动");
  await table.focus();
  await expect(table).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: "新建文档", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#note-title")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
