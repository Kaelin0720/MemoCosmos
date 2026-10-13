import { test, expect, type Page } from "./test";
import { fixtureTag, mockApi } from "./api-fixture";

async function openCreate(page: Page, name: string, description = "") {
  await page.getByRole("button", { name: "新增标签", exact: true }).click();
  await page.getByLabel("标签名称", { exact: false }).fill(name);
  await page.getByLabel("描述 选填").fill(description);
  await page.getByRole("button", { name: "保存标签", exact: true }).click();
}

test("标签 CRUD、重名、查询和成功反馈遵循接口结果", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/tags/");
  await expect(page.getByText("你的第一颗记忆星点")).toBeVisible();
  await openCreate(page, "  RAG  ", "检索增强生成");
  await expect(page.getByRole("row", { name: /RAG 检索增强生成/ })).toBeVisible();
  expect(state.committedCreates).toBe(1);
  await openCreate(page, "rag", "重名不应写入");
  await expect(page.getByRole("alert")).toHaveText("标签名称已存在");
  await expect(page.getByLabel("标签名称", { exact: false })).toBeFocused();
  expect(state.tags).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "操作标签 RAG", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑标签" }).click();
  await page.getByLabel("标签名称", { exact: false }).fill("知识检索");
  await page.getByLabel("描述 选填").fill("更新后的描述");
  await page.getByRole("button", { name: "保存标签", exact: true }).click();
  await expect(page.getByText("标签已更新。", { exact: true })).toBeVisible();
  await page.getByLabel("搜索标签").fill("不存在");
  await expect(page.getByText("没有找到匹配的标签")).toBeVisible();
  await page.getByLabel("搜索标签").fill("更新后");
  await expect(page.getByRole("row", { name: /知识检索 更新后的描述/ })).toBeVisible();
  await page.getByRole("button", { name: "操作标签 知识检索", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除标签" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "保留标签" }).click();
  expect(state.tags).toHaveLength(1);
  await page.getByRole("button", { name: "操作标签 知识检索", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除标签" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByText("标签已删除。", { exact: true })).toBeVisible();
  expect(state.tags).toHaveLength(0);
  const stored = await page.evaluate(() => [
    JSON.stringify(localStorage),
    JSON.stringify(sessionStorage),
  ]);
  expect(stored.join("")).not.toContain("test-token");
});

test("令牌轮换后只重新 Bootstrap 并重试一次，不重复创建", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/tags/");
  await expect(page.getByText("你的第一颗记忆星点")).toBeVisible();
  state.token = "test-token-2";
  await openCreate(page, "令牌恢复");
  await expect(page.getByRole("row", { name: /令牌恢复/ })).toBeVisible();
  expect(state.postCalls).toBe(2);
  expect(state.bootstrapCalls).toBe(2);
  expect(state.committedCreates).toBe(1);
});

test("第二次令牌拒绝停止重试，保留表单并显示错误", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/tags/");
  await expect(page.getByText("你的第一颗记忆星点")).toBeVisible();
  state.rejectTokens = true;
  await openCreate(page, "不能保存");
  await expect(page.getByRole("alert")).toHaveText("本机会话令牌已失效");
  expect(state.postCalls).toBe(2);
  expect(state.committedCreates).toBe(0);
  await expect(page.getByRole("dialog", { name: "新增标签" })).toBeVisible();
});

test("服务断连时显示读取错误，可以恢复重试", async ({ page }) => {
  const state = await mockApi(page);
  state.offline = true;
  await page.goto("/tags/");
  await expect(page.getByRole("heading", { name: "暂时无法读取标签" })).toBeVisible();
  await expect(page.getByText("本机服务未连接", { exact: true })).toBeVisible();
  state.offline = false;
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.getByText("你的第一颗记忆星点")).toBeVisible();
  await expect(page.getByText("本机服务已连接", { exact: true })).toBeVisible();
});

test("网络中断的写入不自动重试，也不报告保存成功", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/tags/");
  await expect(page.getByText("你的第一颗记忆星点")).toBeVisible();
  state.failWrites = true;
  await openCreate(page, "结果未知");
  await expect(page.getByRole("alert")).toContainText("结果尚未确定");
  expect(state.postCalls).toBe(1);
  expect(state.committedCreates).toBe(0);
  await expect(page.getByText("标签已保存到本机记忆库。")).not.toBeVisible();
  await expect(page.getByRole("dialog", { name: "新增标签" })).toBeVisible();
});

test("后到的旧查询不覆盖新查询结果", async ({ page }) => {
  const state = await mockApi(page, [fixtureTag("RAG"), fixtureTag("Java")]);
  state.delays.set("R", 700);
  await page.goto("/tags/");
  await expect(page.getByRole("row", { name: /RAG/ })).toBeVisible();
  await page.getByLabel("搜索标签").fill("R");
  await expect.poll(() => state.queries.includes("R")).toBe(true);
  await page.getByLabel("搜索标签").fill("Java");
  await expect(page.getByRole("row", { name: /Java/ })).toBeVisible();
  await expect.poll(() => state.completedQueries.includes("R")).toBe(true);
  await expect(page.getByRole("row", { name: /RAG/ })).not.toBeVisible();
  await expect(page.getByText("1 个匹配的标签")).toBeVisible();
});
