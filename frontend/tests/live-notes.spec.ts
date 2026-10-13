import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./test";
import type { NoteDetail, NoteSummary } from "../src/lib/note-types";

test("真实临时文档库：文件、目录、阅读、撞名、丢响应、标签联动、重启及外部改动", async ({
  page,
  request,
}) => {
  test.skip(process.env.YIHE_LIVE_NOTES !== "1", "显式开启后才启动本批实际临时后端");
  test.setTimeout(90000);
  const root = await mkdtemp(path.join(tmpdir(), "yihe-notes-integration-"));
  const backendDir = path.resolve("../backend"),
    python = path.join(backendDir, ".venv/bin/python");
  const launcher = path.resolve("tests/live-notes-app.py");
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") return reject(new Error("无法分配测试端口"));
      socket.close(() => resolve(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null,
    posts = 0,
    loseAccepted = false;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function start() {
    const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    for (const key of Object.keys(environment))
      if (/^CHAT_MODEL_|^LANGSMITH_|^LANGCHAIN_TRACING/.test(key))
        delete environment[key as keyof typeof environment];
    child = spawn(python, [launcher, "--root", root, "--port", String(port)], {
      cwd: backendDir,
      env: environment,
      stdio: "ignore",
    });
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
      const timeout = setTimeout(() => current.kill("SIGKILL"), 3000);
      current.once("exit", () => {
        clearTimeout(timeout);
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
  async function get<T>(pathname: string): Promise<T> {
    const response = await request.get(`${origin}${pathname}`, { headers: await headers() });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  async function space(name: string) {
    await page.getByRole("button", { name: /切换空间/ }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  }
  async function draft(title: string, body: string) {
    await page.getByRole("button", { name: "新建文档", exact: true }).click();
    await page.locator("#note-title").fill(title);
    await page.getByRole("checkbox", { name: "Redis", exact: true }).check();
    await page.getByLabel("Markdown 正文", { exact: false }).fill(body);
  }
  async function clearDraft() {
    await page.getByRole("button", { name: "清空草稿", exact: true }).click();
    await page.getByRole("button", { name: "确认清空草稿" }).click();
  }
  async function screenshot(file: string) {
    const toast = page.getByRole("button", { name: "关闭通知", exact: true });
    if (await toast.isVisible()) await toast.click();
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      document.querySelectorAll("textarea").forEach((input) => {
        input.scrollTop = 0;
      });
      window.scrollTo(0, 0);
    });
    await expect(page.locator(".toast")).toHaveCount(0);
    await page.screenshot({ path: file, fullPage: true });
  }
  try {
    await start();
    await page.route("http://127.0.0.1:8009/**", async (route) => {
      const incoming = new URL(route.request().url());
      const url = `${origin}${incoming.pathname}${incoming.search}`;
      if (route.request().method() === "POST" && incoming.pathname === "/api/v1/notes") {
        posts++;
        if (loseAccepted) {
          loseAccepted = false;
          const response = await route.fetch({ url });
          expect(response.status()).toBe(201);
          return route.abort("connectionfailed");
        }
      }
      return route.continue({ url });
    });
    await page.goto("/tags/");
    await page.getByRole("button", { name: "新增标签", exact: true }).click();
    await page.getByLabel("标签名称", { exact: false }).fill("Redis");
    await page.getByLabel("描述 选填").fill("仅用于本批临时库联调");
    await page.getByRole("button", { name: "保存标签", exact: true }).click();
    await expect(page.getByRole("row", { name: /Redis 仅用于/ })).toBeVisible();
    const tagId = (await get<{ items: { id: string }[] }>("/api/v1/tags")).items[0].id;
    await space("知识宇宙");
    await expect(page.getByText("还没有主题文档")).toBeVisible();
    const body =
      "  ## 查询缓存的使用\n\n项目 A 已加入查询缓存，缓存穿透仍需要继续实验。\n\n- 先核对请求与命中率\n- 保留问题，记录下一次验证\n\n| 项目 | 状态 |\n| --- | --- |\n| 查询缓存 | 已验证 |\n| 缓存穿透 | 待理解 |\n\n[外部参考](https://example.org/cache) · [# 关联文档](./related.md)\n  ";
    await draft("Redis 学习记录 · 临时联调", body);
    await page.getByLabel("出处", { exact: false }).fill("测试来源：本批临时 API 的人工示例");
    await screenshot("previews/10-notes-create.png");
    await page.getByRole("button", { name: "保存文档", exact: true }).click();
    await expect(page.locator(".note-notice")).toContainText("已保存「Redis 学习记录 · 临时联调」");
    await expect(page.getByRole("article", { name: "文档原文" })).toContainText("查询缓存的使用");
    const id = new URL(page.url()).searchParams.get("note")!;
    const original = await get<NoteDetail>(`/api/v1/notes/${id}`);
    expect(original.body).toBe(body);
    expect(original.tags[0].id).toBe(tagId);
    expect(original.sync_status).toBe("synced");
    const file = path.join(root, `memory/notes/topics/${id}.md`);
    const bytes = await readFile(file, "utf8");
    expect(bytes).toContain(id);
    expect(bytes).toContain("# Redis 学习记录 · 临时联调");
    expect(bytes.endsWith(body)).toBe(true);
    const list = await get<{ items: NoteSummary[] }>("/api/v1/notes");
    expect(list.items[0]).not.toHaveProperty("body");
    await screenshot("previews/09-notes-desktop.png");
    await page.setViewportSize({ width: 393, height: 852 });
    await screenshot("previews/11-notes-mobile.png");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await draft(original.title, "这份撞名新稿需要保留，不能覆盖原文。");
    await page.getByRole("button", { name: "保存文档", exact: true }).click();
    await expect(page.locator(".note-notice")).toContainText("同标题文档已存在");
    await page.getByRole("button", { name: "打开原文", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`note=${id}`));
    await expect(page.locator(".note-reader")).toContainText("项目 A 已加入查询缓存");
    await page.getByRole("button", { name: "返回草稿" }).click();
    await expect(page.getByLabel("Markdown 正文", { exact: false })).toHaveValue(
      "这份撞名新稿需要保留，不能覆盖原文。",
    );
    expect(await readFile(file, "utf8")).toBe(bytes);
    await clearDraft();
    await page.locator("#note-title").fill("响应丢失 · 临时联调");
    await page.getByRole("checkbox", { name: "Redis", exact: true }).check();
    await page
      .getByLabel("Markdown 正文", { exact: false })
      .fill("实际已落盘，但浏览器必须保持结果未确认。");
    loseAccepted = true;
    await page.getByRole("button", { name: "保存文档", exact: true }).click();
    await expect(page.locator(".note-notice")).toContainText("保存结果未确认");
    await page.getByRole("button", { name: "读取目录核对" }).click();
    await page.locator(".note-entry").filter({ hasText: "响应丢失 · 临时联调" }).click();
    await expect(page.locator(".note-reader")).toContainText("实际已落盘");
    await expect(page.locator(".note-notice")).toContainText("保存结果未确认");
    expect(posts).toBe(3);
    await page.getByRole("button", { name: "返回草稿" }).click();
    await clearDraft();
    await space("标签池");
    await page.getByRole("button", { name: "操作标签 Redis", exact: true }).click();
    await page.getByRole("menuitem", { name: "编辑标签" }).click();
    await page.getByLabel("标签名称", { exact: false }).fill("缓存实验");
    await page.getByRole("button", { name: "保存标签", exact: true }).click();
    await expect(page.getByText("标签已更新。", { exact: true })).toBeVisible();
    await space("知识宇宙");
    await page.locator(".note-entry").filter({ hasText: original.title }).click();
    await expect(page.locator(".note-reader .note-tags")).toContainText("缓存实验");
    const renamed = await get<NoteDetail>(`/api/v1/notes/${id}`);
    expect(renamed.version).toBeGreaterThan(original.version);
    expect(renamed.body).toBe(body);
    expect(await readFile(file, "utf8")).toContain("缓存实验");
    await space("标签池");
    await page.getByRole("button", { name: "操作标签 缓存实验", exact: true }).click();
    await page.getByRole("menuitem", { name: "删除标签" }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("标签已删除。", { exact: true })).toBeVisible();
    await space("知识宇宙");
    await page.locator(".note-entry").filter({ hasText: original.title }).click();
    await expect(page.locator(".note-reader .note-tags")).toHaveText("未分类");
    const untagged = await get<NoteDetail>(`/api/v1/notes/${id}`);
    expect(untagged.body).toBe(body);
    expect(untagged.tags).toEqual([]);
    await stop();
    await start();
    await page.reload();
    await expect(page.locator(".note-reader")).toContainText("查询缓存的使用");
    expect((await get<NoteDetail>(`/api/v1/notes/${id}`)).id).toBe(id);
    const external = (await readFile(file, "utf8")) + "\n用户在编辑器中写入的外部内容\n";
    await writeFile(file, external);
    await page.getByRole("button", { name: "刷新目录" }).click();
    await expect(page.locator(".notes-document [role=alert]")).toContainText("暂时无法读取原文");
    await expect(page.locator(".note-reader")).toHaveCount(0);
    await expect(page.locator(".notes-directory")).toContainText("文件有冲突");
    expect(await readFile(file, "utf8")).toBe(external);
    const database = spawnSync(
      python,
      [
        "-c",
        "import sqlite3,sys,json; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps([c.execute('SELECT version_num FROM alembic_version').fetchone()[0], c.execute('SELECT COUNT(*) FROM notes').fetchone()[0], c.execute('SELECT COUNT(*) FROM note_tags').fetchone()[0]])); c.close()",
        path.join(root, "memory/.assistant/memory.sqlite"),
      ],
      { encoding: "utf8" },
    );
    expect(database.status).toBe(0);
    expect(JSON.parse(database.stdout)).toEqual(["0004_second_brain", 2, 0]);
    expect(errors).toEqual([]);
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
