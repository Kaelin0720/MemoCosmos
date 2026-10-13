import { test, expect, type Page } from "./test";
import { fixtureNote, mockNotes } from "./notes-fixture";
import { mockMemory } from "./memory-fixture";

async function language(page: Page, choice: "English" | "简体中文") {
  await page.locator(".language-trigger").click();
  await page.getByRole("menuitem", { name: choice, exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", choice === "English" ? "en" : "zh-CN");
}

test("探索星图可以浏览、缩放与切换，不会创建或修改真实记忆", async ({ page }) => {
  const notes = await mockNotes(page);
  const memory = await mockMemory(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (/\/api\//.test(request.url()) && !["GET", "OPTIONS"].includes(request.method()))
      writes.push(request.url());
  });
  await page.goto("/knowledge/");
  await page.getByRole("button", { name: "探索星图", exact: true }).click();
  const graph = page.locator(".memory-graph");
  await expect(graph).toContainText("体验模式 · 不写入记忆库");
  await expect(graph.locator(".graph-node")).toHaveCount(14);
  const canvas = graph.locator("svg[viewBox]");
  const before = await canvas.locator(":scope > g").last().getAttribute("transform");
  await graph.getByRole("button", { name: "放大星图" }).click();
  await expect(canvas.locator(":scope > g").last()).not.toHaveAttribute("transform", before!);
  await graph.getByRole("button", { name: "复位星图" }).click();
  await expect(canvas.locator(":scope > g").last()).toHaveAttribute("transform", before!);
  const node = graph.getByRole("button", { name: "选择节点 RAG 检索", exact: true });
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(graph.locator(".graph-details h3")).toHaveText("RAG 检索");
  const position = await node.getAttribute("transform");
  await page.keyboard.press("ArrowRight");
  await expect(node).not.toHaveAttribute("transform", position!);
  await graph.getByRole("button", { name: "查看主题", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "RAG 检索" });
  await expect(dialog).toContainText("不会保存在你的记忆库");
  await dialog.getByRole("button", { name: "切片策略", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "切片策略" })).toBeVisible();
  await page.keyboard.press("Escape");
  await graph.getByRole("button", { name: "我的知识", exact: true }).click();
  await expect(graph.locator(".graph-node")).toHaveCount(0);
  await expect(graph).toContainText("等待你的第一颗记忆星点");
  expect(notes.posts).toBe(0);
  expect(notes.patches).toEqual([]);
  expect(memory.actions).toEqual([]);
  expect(writes).toEqual([]);
});

test("中英文切换保留文档和草稿，跨页面及刷新记住语言", async ({ page }) => {
  const note = fixtureNote("我的学习记录", "我昨天学了切片策略");
  await mockNotes(page, [note]);
  await mockMemory(page);
  await page.goto(`/knowledge/?note=${note.id}`);
  await page.getByRole("button", { name: "编辑文档", exact: true }).click();
  await page.locator("#note-body").fill("待保存的中文草稿");
  await language(page, "English");
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeVisible();
  await expect(page.locator("#note-title")).toHaveValue("我的学习记录");
  await expect(page.locator("#note-body")).toHaveValue("待保存的中文草稿");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Make this space your own", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Model name", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("button", { name: "Save model configuration", exact: true }),
  ).toBeVisible();
  await language(page, "简体中文");
  await expect(
    page.getByRole("heading", { name: "让这个空间更适合你", exact: true }),
  ).toBeVisible();
});

test("英文星图与手机深色界面可用，减少动画时停止光流", async ({ page }) => {
  await mockNotes(page);
  await mockMemory(page);
  await page.setViewportSize({ width: 393, height: 852 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/knowledge/?view=graph&mode=explore");
  await language(page, "English");
  await expect(page.locator(".graph-details h3")).toHaveText("Second brain");
  await expect(page.locator(".memory-graph")).toContainText("Preview · not saved to your library");
  await expect(page.locator(".graph-particle")).toHaveCount(0);
  await expect(page.locator(".nebula-image")).toHaveCSS("animation-name", "none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(11, 11, 18)");
  await page.getByRole("button", { name: "View topic", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Second brain" });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Switch space/ }).click();
  await page.getByRole("menuitem", { name: "Tags", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tags", exact: true })).toBeVisible();
});
