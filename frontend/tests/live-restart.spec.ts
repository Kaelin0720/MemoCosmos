import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "./test";
import type { Tag } from "../src/lib/api";

test("真实临时记忆库：界面写入 SQLite，后端重启恢复，失效令牌只重试一次", async ({
  page,
  request,
}) => {
  test.skip(process.env.YIHE_LIVE_RESTART !== "1", "显式开启后才启动真实后端临时进程");
  test.setTimeout(45000);
  const memoryDir = await mkdtemp(path.join(tmpdir(), "yihe-frontend-live-"));
  const backendDir = path.resolve("../backend");
  const python = path.join(backendDir, ".venv/bin/python");
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配测试端口"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  async function start() {
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    for (const key of Object.keys(env))
      if (/^CHAT_MODEL_|^LANGSMITH_|^LANGCHAIN_TRACING/.test(key))
        delete env[key as keyof typeof env];
    child = spawn(
      python,
      [path.resolve("tests/live-notes-app.py"), "--root", memoryDir, "--port", String(port)],
      {
        cwd: backendDir,
        stdio: "ignore",
        env,
      },
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
        { timeout: 10000 },
      )
      .toBe(true);
  }
  async function stop() {
    const processToStop = child;
    child = null;
    if (!processToStop || processToStop.exitCode !== null || processToStop.signalCode !== null)
      return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => processToStop.kill("SIGKILL"), 3000);
      processToStop.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      processToStop.kill("SIGTERM");
    });
  }
  async function readTags(): Promise<Tag[]> {
    const boot = await request.get(`${origin}/api/v1/bootstrap`);
    const headers = { "X-Local-Token": (await boot.json()).local_token as string };
    const response = await request.get(`${origin}/api/v1/tags`, { headers });
    return (await response.json()).items;
  }
  function sqliteTags(): [string, string][] {
    const result = spawnSync(
      python,
      [
        "-c",
        "import sqlite3,sys,json; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps(c.execute('SELECT id,name FROM tags ORDER BY name').fetchall(),ensure_ascii=False)); c.close()",
        path.join(memoryDir, "memory/.assistant/memory.sqlite"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  }
  async function create(name: string, description: string) {
    await page.getByRole("button", { name: "新增标签", exact: true }).click();
    await page.getByLabel("标签名称", { exact: false }).fill(name);
    await page.getByLabel("描述 选填").fill(description);
    await page.getByRole("button", { name: "保存标签", exact: true }).click();
    await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();
  }
  try {
    await start();
    // Forward browser requests to an actual FastAPI process, without mocking responses.
    // It uses a separate port and temporary library, leaving the shared service intact.
    await page.route("http://127.0.0.1:8009/**", (route) => {
      const incoming = new URL(route.request().url());
      return route.continue({ url: `${origin}${incoming.pathname}${incoming.search}` });
    });
    await page.goto("/tags/");
    await expect(page.getByText("你的第一颗记忆星点")).toBeVisible();
    await create("阶段联调·知识分类", "从页面保存到真实 SQLite，联调结束后清理。");
    const before = (await readTags())[0];
    expect(sqliteTags()).toEqual([[before.id, before.name]]);
    await stop();
    await start();
    let postCount = 0;
    page.on("request", (event) => {
      if (event.method() === "POST" && event.url().includes("/api/v1/tags")) postCount++;
    });
    await create("阶段联调·重启恢复", "服务重启后自动重建本机会话，只保存一条标签。");
    expect(postCount).toBe(2);
    const restored = await readTags();
    expect(restored).toHaveLength(2);
    expect(restored.find((tag) => tag.id === before.id)).toEqual(before);
    expect(sqliteTags()).toHaveLength(2);
    await page.reload();
    await expect(page.getByRole("row", { name: /阶段联调·知识分类/ })).toBeVisible();
    await page.screenshot({ path: "previews/04-tags-live-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "previews/05-tags-live-mobile.png", fullPage: true });
    for (const tag of restored) {
      await page.getByRole("button", { name: `操作标签 ${tag.name}`, exact: true }).click();
      await page.getByRole("menuitem", { name: "删除标签" }).click();
      await page.getByRole("button", { name: "确认删除" }).click();
      await expect(
        page.getByRole("button", { name: `操作标签 ${tag.name}`, exact: true }),
      ).not.toBeVisible();
    }
    expect(sqliteTags()).toEqual([]);
  } finally {
    await stop();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
