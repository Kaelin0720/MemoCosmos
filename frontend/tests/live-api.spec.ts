import { randomUUID } from "node:crypto";
import { test, expect } from "./test";
import type { Tag } from "../src/lib/api";

test("真实 FastAPI：从页面创建、查询、修改、刷新恢复和删除", async ({ page, request }) => {
  test.skip(process.env.YIHE_LIVE_API !== "1", "显式开启后才向正在运行的真实本机服务写入测试标签");
  const prefix = `前端联调-${randomUUID().slice(0, 8)}`;
  const original = `${prefix}-初始`;
  const renamed = `${prefix}-更新`;
  let id: string | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function apiHeaders() {
    const boot = await request.get("http://127.0.0.1:8009/api/v1/bootstrap");
    expect(boot.ok()).toBe(true);
    return { "X-Local-Token": (await boot.json()).local_token as string };
  }
  try {
    await page.goto("/tags/");
    await expect(page.getByText("本机服务已连接", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "新增标签", exact: true }).click();
    await page.getByLabel("标签名称", { exact: false }).fill(original);
    await page.getByLabel("描述 选填").fill("真实界面到 SQLite 的联调记录，测试结束删除");
    await page.getByRole("button", { name: "保存标签", exact: true }).click();
    await expect(page.getByRole("row", { name: new RegExp(original) })).toBeVisible();
    const response = await request.get(
      `http://127.0.0.1:8009/api/v1/tags?q=${encodeURIComponent(prefix)}`,
      { headers: await apiHeaders() },
    );
    const saved = (await response.json()).items[0] as Tag;
    expect(saved.name).toBe(original);
    id = saved.id;
    await page.getByRole("button", { name: `操作标签 ${original}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "编辑标签" }).click();
    await page.getByLabel("标签名称", { exact: false }).fill(renamed);
    await page.getByLabel("描述 选填").fill("更新后可通过描述查询");
    await page.getByRole("button", { name: "保存标签", exact: true }).click();
    await expect(page.getByText("标签已更新。", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByLabel("搜索标签").fill(prefix);
    await expect(page.getByRole("row", { name: new RegExp(renamed) })).toBeVisible();
    const updated = await request.get(
      `http://127.0.0.1:8009/api/v1/tags?q=${encodeURIComponent(prefix)}`,
      { headers: await apiHeaders() },
    );
    const actual = (await updated.json()).items[0] as Tag;
    expect(actual.id).toBe(saved.id);
    expect(actual.created_at).toBe(saved.created_at);
    expect(actual.description).toBe("更新后可通过描述查询");
    await page.getByRole("button", { name: `操作标签 ${renamed}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "删除标签" }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("标签已删除。", { exact: true })).toBeVisible();
    await expect(page.getByText("没有找到匹配的标签")).toBeVisible();
    const deleted = await request.get(
      `http://127.0.0.1:8009/api/v1/tags?q=${encodeURIComponent(prefix)}`,
      { headers: await apiHeaders() },
    );
    expect((await deleted.json()).total).toBe(0);
    id = undefined;
    expect(errors).toEqual([]);
  } finally {
    const headers = await apiHeaders();
    const remaining = await request.get(
      `http://127.0.0.1:8009/api/v1/tags?q=${encodeURIComponent(prefix)}`,
      { headers },
    );
    for (const tag of (await remaining.json()).items as Tag[]) {
      if (tag.name.startsWith(prefix) || tag.id === id)
        await request.delete(`http://127.0.0.1:8009/api/v1/tags/${tag.id}`, { headers });
    }
  }
});
