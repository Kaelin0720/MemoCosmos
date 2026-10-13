import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./test";
import type { NoteDetail, NoteSummary } from "../src/lib/note-types";
import type { MemoryJob, MemoryGraph } from "../src/lib/memory-types";

test("完整真实临时库：聊天自动整理、目录编辑链接、星图证据、确认重试、外部导入、ZIP恢复与删除", async ({
  page,
  request,
}) => {
  test.skip(process.env.YIHE_LIVE_COMPLETION !== "1", "显式开启完整体验隔离联调");
  test.setTimeout(120000);
  const root = await mkdtemp(path.join(tmpdir(), "yihe-completion-"));
  const backend = path.resolve("../backend"),
    python = path.join(backend, ".venv/bin/python"),
    launcher = path.resolve("tests/live-completion-app.py");
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("测试端口分配失败"));
      server.close(() => resolve(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  let restored = "";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function start(memory?: string) {
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    for (const key of Object.keys(env))
      if (/^CHAT_MODEL_|^LANGSMITH_|^LANGCHAIN_TRACING/.test(key))
        delete env[key as keyof typeof env];
    child = spawn(
      python,
      [
        launcher,
        "--root",
        root,
        "--port",
        String(port),
        ...(memory ? ["--memory-dir", memory] : []),
      ],
      { cwd: backend, env, stdio: "ignore" },
    );
    await expect
      .poll(
        async () => {
          try {
            return (await request.get(`${origin}/health`, { timeout: 500 })).ok();
          } catch {
            return false;
          }
        },
        { timeout: 15000 },
      )
      .toBe(true);
  }
  async function stop() {
    const current = child;
    child = null;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => current.kill("SIGKILL"), 3000);
      current.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      current.kill("SIGTERM");
    });
  }
  async function headers() {
    return {
      "X-Local-Token": (await (await request.get(`${origin}/api/v1/bootstrap`)).json())
        .local_token as string,
    };
  }
  async function get<T>(url: string): Promise<T> {
    const response = await request.get(`${origin}${url}`, { headers: await headers() });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  async function space(name: string) {
    await page.getByRole("button", { name: /切换空间/ }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  async function send(content: string) {
    await page.getByLabel("消息内容").fill(content);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByRole("heading", { name: "临时联调回复" }).last()).toBeVisible();
  }
  async function shot(file: string) {
    const toast = page.getByRole("button", { name: "关闭通知", exact: true });
    if (await toast.isVisible()) await toast.click();
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: `previews/${file}`, fullPage: true });
  }
  try {
    await start();
    await page.route("http://127.0.0.1:8009/**", (route) => {
      const incoming = new URL(route.request().url());
      return route.continue({ url: `${origin}${incoming.pathname}${incoming.search}` });
    });
    await page.goto("/knowledge/");
    await expect(page.getByText("还没有主题文档")).toBeVisible();
    expect((await get<{ total: number }>("/api/v1/notes")).total).toBe(0);
    await space("设置");
    await page.getByLabel("API URL", { exact: true }).fill("https://example.invalid/v1");
    await page.getByLabel("模型名称", { exact: true }).fill("completion-test-fixture");
    await page.locator("#model-key").fill("completion-test-secret");
    await page.getByRole("button", { name: "保存模型配置" }).click();
    await expect(page.getByText("配置已齐全，可在会话中验证连接", { exact: false })).toBeVisible();
    await space("工作台");
    await send("Redis 缓存用于查询缓存");
    await expect(page.locator(".conversation-jobs")).toContainText("已整理", { timeout: 15000 });
    await page.getByRole("link", { name: "新增 · Redis 缓存", exact: true }).click();
    await expect(page.locator(".note-reader")).toContainText("Redis 缓存");
    const noteId = new URL(page.url()).searchParams.get("note")!;
    const original = await get<NoteDetail>(`/api/v1/notes/${noteId}`);
    expect(original.folder).toBe("知识/数据库");
    expect(original.tags[0].name).toBe("缓存");
    expect(
      await readFile(path.join(root, "memory/notes/topics", `${noteId}.md`), "utf8"),
    ).toContain("Redis 缓存");
    await shot("12-knowledge-complete.png");
    await page
      .locator(".note-relations")
      .getByRole("link", { name: "查询缓存", exact: true })
      .click();
    await expect(page.locator(".note-reader")).toContainText("实验思路");
    await page.getByRole("button", { name: "关系星图", exact: true }).click();
    await page.getByRole("button", { name: "暂停运动", exact: true }).click();
    await page.getByRole("button", { name: "选择节点 Redis 缓存", exact: true }).click();
    await page.locator(".graph-relation").first().click();
    await expect(page.locator(".graph-evidence")).toContainText("版本");
    await shot("13-memory-graph.png");
    await page.getByRole("button", { name: "打开文档", exact: true }).click();
    await page.getByRole("button", { name: "编辑文档", exact: true }).click();
    await page.locator("#note-folder").fill("项目/人工归档");
    await page
      .locator("#note-body")
      .fill(`${original.body}\n\n## 人工补充\n\n用户编辑优先的内容。`);
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.locator(".note-reader")).toContainText("用户编辑优先的内容");
    const edited = await get<NoteDetail>(`/api/v1/notes/${noteId}`);
    expect(edited.version).toBeGreaterThan(original.version);
    await page.getByRole("button", { name: "版本记录", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("人工编辑");
    await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await page.getByText("章节与正文检索", { exact: true }).click();
    await page.locator("#memory-query").fill("人工补充");
    await page.getByRole("button", { name: "检索", exact: true }).click();
    await page.locator(".memory-hit").first().click();
    await expect(page.locator("#人工补充")).toBeVisible();
    await writeFile(
      path.join(root, "memory/notes/topics", `${noteId}.md`),
      "# Redis 缓存\n\n## 外部修订\n\n这是临时测试外部修改。\n",
    );
    await page.getByRole("button", { name: "刷新目录", exact: true }).click();
    await page.getByRole("button", { name: "对比外部修改", exact: true }).click();
    const external = page.getByRole("dialog", { name: "外部文件对比" });
    await expect(external).toContainText("用户编辑优先的内容");
    await external.getByRole("checkbox").check();
    await external.getByRole("button", { name: "确认导入外部修改" }).click();
    await expect(page.locator(".note-reader")).toContainText("这是临时测试外部修改");
    await page.setViewportSize({ width: 393, height: 852 });
    await page.getByRole("button", { name: "收起目录", exact: true }).click();
    await shot("15-mobile-complete.png");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await space("工作台");
    await send("确认这份缓存记录的主体");
    await expect(page.locator(".conversation-jobs")).toContainText("待你确认", { timeout: 10000 });
    await page.getByLabel("补充澄清（选填）").fill("只保存通用概念，不是我的完成经历");
    await page.getByRole("button", { name: "提交澄清", exact: true }).click();
    await expect(page.locator(".conversation-jobs .needs_confirmation")).toHaveCount(0, {
      timeout: 10000,
    });
    await send("测试一次整理故障");
    await expect(page.locator(".conversation-jobs")).toContainText("整理失败", { timeout: 10000 });
    await page.getByRole("button", { name: "重新整理", exact: true }).click();
    await expect(page.locator(".conversation-jobs .failed")).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator(".conversation-jobs")).toContainText("显式重试已成功判断", {
      timeout: 10000,
    });
    const jobs = await get<{ items: MemoryJob[] }>("/api/v1/memory/jobs");
    expect(jobs.items.some((job) => job.status === "completed")).toBe(true);
    expect(jobs.items.some((job) => job.status === "skipped")).toBe(true);
    await space("设置");
    await page.getByRole("switch", { name: "自动整理", exact: true }).click();
    await expect(page.getByRole("switch", { name: "自动整理", exact: true })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    const jobCount = (await get<{ total: number }>("/api/v1/memory/jobs")).total;
    await space("工作台");
    await send("已关闭自动整理后的原始消息");
    expect((await get<{ total: number }>("/api/v1/memory/jobs")).total).toBe(jobCount);
    await space("设置");
    await shot("14-memory-settings.png");
    const beforeNotes = await get<{ items: NoteSummary[] }>("/api/v1/notes"),
      beforeGraph = await get<MemoryGraph>("/api/v1/memory/graph");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出记忆 ZIP" }).click();
    const zip = path.join(root, "export.zip");
    await (await downloadPromise).saveAs(zip);
    const data = await readFile(zip);
    expect(data.subarray(0, 2).toString()).toBe("PK");
    await page.locator("#memory-zip").setInputFiles(zip);
    await page.getByRole("button", { name: "恢复到新库", exact: true }).click();
    await page.getByRole("button", { name: "确认恢复到新库", exact: true }).click();
    await expect(page.locator(".memory-restored")).toContainText("已恢复到新目录", {
      timeout: 20000,
    });
    restored = (await page.locator(".memory-restored code").first().textContent())!;
    expect(restored.startsWith(path.join(await realpath(root), "restored"))).toBe(true);
    await stop();
    await start(restored);
    const afterNotes = await get<{ items: NoteSummary[] }>("/api/v1/notes");
    expect(afterNotes.items.map((note) => [note.id, note.folder, note.version]).sort()).toEqual(
      beforeNotes.items.map((note) => [note.id, note.folder, note.version]).sort(),
    );
    expect(
      (await get<MemoryGraph>("/api/v1/memory/graph")).edges.map((edge) => edge.id).sort(),
    ).toEqual(beforeGraph.edges.map((edge) => edge.id).sort());
    expect((await get<NoteDetail>(`/api/v1/notes/${noteId}`)).body).toContain("外部修订");
    await page.goto(`/knowledge/?note=${noteId}`);
    await page.getByRole("button", { name: "删除笔记", exact: true }).click();
    await page.getByRole("button", { name: "确认删除笔记", exact: true }).click();
    await expect(page.locator(".note-notice")).toContainText("笔记与版本已删除");
    expect((await get<{ total: number }>("/api/v1/notes")).total).toBe(
      beforeNotes.items.length - 1,
    );
    expect((await get<{ total: number }>("/api/v1/conversations")).total).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
