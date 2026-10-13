import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "./test";

test("真实临时 API：配置、Deep Agents 标签工具、中文流、幂等查询、停止、SQLite 与重启恢复", async ({
  page,
  request,
}) => {
  test.skip(process.env.YIHE_LIVE_AGENT !== "1", "显式开启后才启动本批真实临时后端");
  test.setTimeout(90000);
  const root = await mkdtemp(path.join(tmpdir(), "yihe-chat-integration-"));
  const backendDir = path.resolve("../backend"),
    python = path.join(backendDir, ".venv/bin/python");
  const appPath = path.resolve("tests/live-agent-app.py");
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        reject(new Error("无法分配测试端口"));
        return;
      }
      socket.close(() => resolve(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null,
    loseAccepted = false,
    messagePosts = 0,
    cancelPosts = 0,
    byClientLookups = 0;
  const errors: string[] = [];
  let backendOutput = "";
  page.on("pageerror", (error) => errors.push(error.message));
  async function start() {
    backendOutput = "";
    const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    for (const key of Object.keys(environment))
      if (/^CHAT_MODEL_|^LANGSMITH_|^LANGCHAIN_TRACING/.test(key))
        delete environment[key as keyof typeof environment];
    child = spawn(python, [appPath, "--root", root, "--port", String(port)], {
      cwd: backendDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    child.stdout?.on("data", (chunk) => (backendOutput = (backendOutput + chunk).slice(-8000)));
    child.stderr?.on("data", (chunk) => (backendOutput = (backendOutput + chunk).slice(-8000)));
    try {
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
    } catch (cause) {
      throw new Error(
        `Temporary backend startup failed (exit ${child.exitCode}, signal ${child.signalCode}): ${backendOutput}`,
        { cause },
      );
    }
  }
  async function stop(crash = false) {
    const current = child;
    child = null;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => current.kill("SIGKILL"), 3000);
      current.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      current.kill(crash ? "SIGKILL" : "SIGTERM");
    });
  }
  async function headers() {
    return {
      "X-Local-Token": (await (await request.get(`${origin}/api/v1/bootstrap`)).json())
        .local_token as string,
    };
  }
  async function api(pathname: string) {
    const response = await request.get(`${origin}${pathname}`, { headers: await headers() });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  async function configure(model: string, key = "") {
    await page.goto("/settings/");
    await expect(page.getByLabel("API URL", { exact: true })).toBeEnabled();
    await page.getByLabel("API URL", { exact: true }).fill("https://example.invalid/v1");
    await page.getByLabel("模型名称", { exact: true }).fill(model);
    await page.locator("#model-key").fill(key);
    await page.getByRole("button", { name: "保存模型配置" }).click();
    await expect(page.getByText("配置已齐全，可在会话中验证连接", { exact: false })).toBeVisible();
    await expect(page.locator("#model-key")).toHaveValue("");
  }
  async function send(content: string) {
    await page.getByLabel("消息内容").fill(content);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page).toHaveURL(/conversation=[\da-f-]+/);
    return new URL(page.url()).searchParams.get("conversation")!;
  }
  function storedMessages() {
    const result = spawnSync(
      python,
      [
        "-c",
        "import sqlite3,sys,json; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps(c.execute('SELECT role,content,status FROM messages ORDER BY created_at,seq').fetchall(),ensure_ascii=False)); c.close()",
        path.join(root, "memory/.assistant/memory.sqlite"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as [string, string, string][];
  }
  try {
    await start();
    await page.route("http://127.0.0.1:8009/**", async (route) => {
      const incoming = new URL(route.request().url()),
        method = route.request().method();
      const url = `${origin}${incoming.pathname}${incoming.search}`;
      if (method === "POST" && /\/conversations\/[^/]+\/messages$/.test(incoming.pathname)) {
        messagePosts++;
        if (loseAccepted) {
          loseAccepted = false;
          const response = await route.fetch({ url });
          expect(response.status()).toBe(202);
          return route.abort("connectionfailed");
        }
      }
      if (method === "POST" && incoming.pathname.endsWith("/cancel")) cancelPosts++;
      if (incoming.pathname.includes("/runs/by-client-message/")) byClientLookups++;
      return route.continue({ url });
    });
    await page.goto("/");
    await expect(page.getByText("云端模型尚未配置", { exact: true })).toBeVisible();
    const conversation = await request.post(`${origin}/api/v1/conversations`, {
      headers: await headers(),
      data: {},
    });
    const missingId = (await conversation.json()).id;
    const missing = await request.post(`${origin}/api/v1/conversations/${missingId}/messages`, {
      headers: await headers(),
      data: { client_message_id: randomUUID(), content: "  缺配置时的原始记录  " },
    });
    expect(missing.status()).toBe(202);
    await page.goto(`/?conversation=${missingId}`);
    await expect(page.locator(".workbench [role=alert]")).toContainText("云端模型尚未配置");
    await expect(page.getByRole("article", { name: "用户消息", exact: true })).toContainText(
      "缺配置时的原始记录",
    );
    await configure("browser-fixture", "browser-only-fixture-secret");
    const config = await api("/api/v1/agent/status");
    expect(config.model).toBe("browser-fixture");
    expect(config.has_api_key).toBe(true);
    expect(config).not.toHaveProperty("api_key");
    expect((await stat(path.join(root, "config/model.json"))).mode & 0o777).toBe(0o600);
    await request.post(`${origin}/api/v1/tags`, {
      headers: await headers(),
      data: { name: "RAG", description: "仅用于临时联调" },
    });
    await page.goto("/");
    const toolId = await send("请查标签 RAG");
    await expect(page.getByText("查到标签：RAG。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
    const toolMessages = await api(`/api/v1/conversations/${toolId}/messages`);
    expect(toolMessages.items).toHaveLength(2);
    expect(toolMessages.items[1].content).toBe("查到标签：RAG。");
    loseAccepted = true;
    await send("这一轮显示中文 Markdown，提交结果通过原 ID 核对");
    await expect(page.getByRole("heading", { name: "临时库联调" })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
    expect(messagePosts).toBe(2);
    expect(byClientLookups).toBe(1);
    await expect(page.getByRole("link", { name: "关联资料", exact: true })).toBeVisible();
    expect((await api(`/api/v1/conversations/${toolId}/messages`)).items).toHaveLength(4);
    await page.screenshot({ path: "previews/06-main-agent-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 393, height: 852 });
    await page.screenshot({ path: "previews/08-chat-mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await configure("slow-fixture");
    await page.screenshot({ path: "previews/07-model-settings.png", fullPage: true });
    await page.goto("/");
    const stoppedId = await send("临时库真实停止测试");
    await expect(page.locator(".chat-markdown")).not.toHaveText("");
    await page.getByRole("button", { name: "停止生成" }).click();
    await expect(page.getByText("已停止 · 已保留回复片段")).toBeVisible();
    expect(cancelPosts).toBe(1);
    const stopped = (await api(`/api/v1/conversations/${stoppedId}/messages`)).items[1];
    expect(stopped.status).toBe("cancelled");
    expect(stopped.content.length).toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByText("已停止 · 已保留回复片段")).toBeVisible();
    const beforeCrash = await send("服务重启中断测试");
    await expect(page.locator(".chat-markdown")).toHaveCount(2);
    await expect(page.locator(".chat-markdown").last()).not.toHaveText("");
    await stop(true);
    await start();
    await page.reload();
    await expect(page.getByText("运行已中断 · 已保留回复片段")).toBeVisible();
    expect((await api(`/api/v1/conversations/${beforeCrash}/messages`)).items.at(-1).status).toBe(
      "interrupted",
    );
    const postsBefore = messagePosts;
    await page.getByRole("button", { name: "会话历史" }).click();
    await expect(page.getByRole("menuitem", { name: /请查标签 RAG/ })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(messagePosts).toBe(postsBefore);
    await configure("error-fixture");
    await page.goto("/");
    const failedId = await send("供应商失败时保留原文");
    await expect(page.locator(".workbench [role=alert]")).toContainText("生成失败");
    const failed = (await api(`/api/v1/conversations/${failedId}/messages`)).items;
    expect(failed[0].content).toBe("供应商失败时保留原文");
    expect(failed[1].status).toBe("failed");
    expect(failed[1].content).toBe("");
    const database = await readFile(path.join(root, "memory/.assistant/memory.sqlite"));
    expect(database.includes(Buffer.from("browser-only-fixture-secret"))).toBe(false);
    expect(storedMessages().filter((item) => item[0] === "user")).toHaveLength(6);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      ),
    ).not.toContain("browser-only-fixture-secret");
    expect(errors).toEqual([]);
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
