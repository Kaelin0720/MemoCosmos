import { frontendOrigin } from "./test";
import { test as base, expect, type Page } from "./test";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentStatus, Conversation, Message, Run, RunStatus } from "../src/lib/chat-types";

const timestamp = "2026-10-10T06:00:00Z";
export const emptyStatus: AgentStatus = {
  configured: false,
  provider: "openai_compatible",
  model: null,
  base_url: null,
  has_api_key: false,
  source: "none",
  reason: "model_not_configured",
  tools: ["list_tags"],
  context_max_chars: 32000,
  context_max_turns: 12,
};
const configured: AgentStatus = {
  ...emptyStatus,
  configured: true,
  model: "test-model",
  base_url: "https://test-model.invalid/v1",
  has_api_key: true,
  source: "file",
  reason: null,
};
type Submission = { client_message_id: string; content: string };
const frame = (event: string, data: unknown) =>
  `event: ${event}\r\n${JSON.stringify(data, null, 2)
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\r\n")}\r\n\r\n`;

// Only tests inject this service and content. The production application has no fixtures.
export async function mockChat(page: Page) {
  const state = {
    status: { ...configured },
    conversations: new Map<string, Conversation>(),
    messages: new Map<string, Message[]>(),
    runs: new Map<string, Run>(),
    mode: "complete" as "complete" | "hold" | "failed" | "interrupted" | "disconnect" | "recover",
    reply: "## 中文回复\n\n星图里的知识，正在形成联系。🌌\n\n[官方资料](https://example.com/docs)",
    partial: "正在形成联系。",
    delayMs: 0,
    chunkSize: 7,
    chunkDelayMs: 0,
    loseNext: null as "accepted" | "missing" | null,
    offline: false,
    rejectEvents: 0,
    posts: [] as Submission[],
    configs: [] as Record<string, string>[],
    cancelCalls: 0,
    eventCalls: 0,
    lookups: 0,
    bootstrapCalls: 0,
    statusReads: 0,
    offsets: [] as number[],
    beforeSeqs: [] as number[],
    token: "chat-test-token",
    truncated: false,
    runReadDelayMs: 0,
    delayedReadsStarted: 0,
    delayedReadsFinished: 0,
    statusReadDelayMs: 0,
    delayedStatusesStarted: 0,
    delayedStatusesFinished: 0,
  };
  const streams = new Map<string, Set<ServerResponse>>();
  const sockets = new Set<import("node:net").Socket>();
  function conversation(title = "新的对话") {
    const item: Conversation = {
      id: randomUUID(),
      title,
      created_at: timestamp,
      updated_at: timestamp,
      active_run_id: null,
    };
    state.conversations.set(item.id, item);
    state.messages.set(item.id, []);
    return item;
  }
  function accept(id: string, body: Submission) {
    const items = state.messages.get(id)!;
    const run: Run = {
      id: randomUUID(),
      conversation_id: id,
      client_message_id: body.client_message_id,
      user_message_id: randomUUID(),
      assistant_message_id: randomUUID(),
      status: "running",
      error: null,
      context_truncated: state.truncated,
      created_at: timestamp,
      updated_at: timestamp,
    };
    items.push({
      id: run.user_message_id,
      conversation_id: id,
      seq: items.length + 1,
      role: "user",
      content: body.content,
      status: "completed",
      run_id: run.id,
      created_at: timestamp,
      updated_at: timestamp,
    });
    items.push({
      id: run.assistant_message_id,
      conversation_id: id,
      seq: items.length + 1,
      role: "assistant",
      content: "",
      status: "running",
      run_id: run.id,
      created_at: timestamp,
      updated_at: timestamp,
    });
    state.runs.set(run.id, run);
    const current = state.conversations.get(id)!;
    current.active_run_id = run.id;
    current.title = body.content.slice(0, 30);
    return run;
  }
  const assistant = (run: Run) =>
    state.messages.get(run.conversation_id)!.find((item) => item.id === run.assistant_message_id)!;
  function finish(run: Run, status: RunStatus = "completed", content = state.reply, notify = true) {
    run.status = status;
    run.error =
      status === "failed"
        ? { code: "model_error", message: "云端模型暂时无法完成请求，请检查模型配置。" }
        : null;
    const message = assistant(run);
    message.content = content;
    message.status = status;
    state.conversations.get(run.conversation_id)!.active_run_id = null;
    if (notify)
      for (const response of streams.get(run.id) ?? []) {
        response.end(frame(`run.${status}`, { run, message }));
      }
  }
  function seedHistory(title: string, count = 2) {
    const current = conversation(title);
    const run = accept(current.id, { client_message_id: randomUUID(), content: title });
    finish(run, "completed", "历史回复", false);
    current.title = title;
    const items = Array.from({ length: count }, (_, index): Message => ({
      id: randomUUID(),
      conversation_id: current.id,
      seq: index + 1,
      role: index % 2 ? "assistant" : "user",
      content: `历史消息 ${index + 1}`,
      status: "completed",
      run_id: run.id,
      created_at: timestamp,
      updated_at: timestamp,
    }));
    run.user_message_id = items.at(-2)!.id;
    run.assistant_message_id = items.at(-1)!.id;
    state.messages.set(current.id, items);
    return current;
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", frontendOrigin);
    response.setHeader("Access-Control-Allow-Headers", "X-Local-Token,Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const run = state.runs.get(request.url!.split("/")[4]);
    if (!run) {
      response.writeHead(404);
      response.end();
      return;
    }
    state.eventCalls++;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    response.flushHeaders();
    const clients = streams.get(run.id) ?? new Set<ServerResponse>();
    clients.add(response);
    streams.set(run.id, clients);
    response.on("close", () => clients.delete(response));
    async function write(text: string) {
      const bytes = Buffer.from(text);
      for (
        let i = 0;
        i < bytes.length && !response.destroyed && !response.writableEnded;
        i += state.chunkSize
      ) {
        response.write(bytes.subarray(i, i + state.chunkSize));
        if (state.chunkDelayMs)
          await new Promise((resolve) => setTimeout(resolve, state.chunkDelayMs));
      }
    }
    const message = assistant(run);
    await write(frame("run.snapshot", { run, message }));
    if (!["pending", "running"].includes(run.status)) {
      response.end(frame(`run.${run.status}`, { run, message }));
      return;
    }
    const piece = ["hold", "failed", "interrupted", "disconnect"].includes(state.mode)
      ? state.partial
      : state.mode === "recover" && state.eventCalls === 1
        ? state.reply.slice(0, 8)
        : state.reply.slice(message.content.length);
    message.content += piece;
    await write(frame("message.delta", { run_id: run.id, message_id: message.id, delta: piece }));
    if (state.mode === "hold") return;
    if (state.mode === "recover" && state.eventCalls === 1) {
      response.end();
      return;
    }
    if (state.mode === "disconnect") {
      finish(run, "completed", state.reply, false);
      response.end();
      return;
    }
    if (state.delayMs) {
      const heartbeat = setInterval(() => {
        if (!response.writableEnded) response.write(": heartbeat\r\n\r\n");
      }, 1500);
      await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      clearInterval(heartbeat);
    }
    if (response.destroyed || response.writableEnded) return;
    const status =
      state.mode === "failed"
        ? "failed"
        : state.mode === "interrupted"
          ? "interrupted"
          : "completed";
    finish(run, status, status === "completed" ? state.reply : message.content, false);
    await write(frame(`run.${status}`, { run, message }));
    response.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  await page.route("http://127.0.0.1:8009/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method(),
      path = url.pathname;
    const respond = (status: number, body?: unknown) =>
      route.fulfill({
        status,
        headers: {
          "Access-Control-Allow-Origin": frontendOrigin,
          "Access-Control-Allow-Headers": "X-Local-Token,Content-Type",
          "Access-Control-Allow-Methods": "GET,POST,PUT",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const error = (status: number, code: string) =>
      respond(status, { error: { code, message: "本机请求未完成" } });
    if (state.offline) return route.abort("connectionrefused");
    if (method === "OPTIONS") return respond(204);
    if (path === "/health") return respond(200, { status: "ok" });
    if (path === "/api/v1/bootstrap") {
      state.bootstrapCalls++;
      return respond(200, { local_token: state.token });
    }
    if (request.headers()["x-local-token"] !== state.token)
      return error(401, "invalid_local_token");
    if (path === "/api/v1/agent/status") {
      state.statusReads++;
      const captured = structuredClone(state.status);
      if (state.statusReadDelayMs) {
        state.delayedStatusesStarted++;
        await new Promise((resolve) => setTimeout(resolve, state.statusReadDelayMs));
        state.delayedStatusesFinished++;
      }
      return respond(200, captured);
    }
    if (path === "/api/v1/agent/config") {
      const input = request.postDataJSON();
      state.configs.push(input);
      state.status = { ...configured, model: input.model, base_url: input.base_url };
      return respond(200, state.status);
    }
    if (path === "/api/v1/memory/jobs") return respond(200, { items: [], total: 0 });
    if (path === "/api/v1/memory/settings") return respond(200, { auto_memory: true });
    if (path === "/api/v1/conversations") {
      if (method === "POST") return respond(201, conversation());
      const offset = Number(url.searchParams.get("offset") ?? 0);
      state.offsets.push(offset);
      return respond(200, {
        items: [...state.conversations.values()].reverse().slice(offset, offset + 50),
        total: state.conversations.size,
      });
    }
    const segments = path.split("/");
    if (segments[3] === "conversations") {
      const current = state.conversations.get(segments[4]);
      if (!current) return error(404, "conversation_not_found");
      if (segments[5] === "runs") {
        state.lookups++;
        const run = [...state.runs.values()].find(
          (item) => item.conversation_id === current.id && item.client_message_id === segments[7],
        );
        return run ? respond(200, run) : error(404, "run_not_found");
      }
      if (segments[5] === "messages") {
        if (method === "POST") {
          const input = request.postDataJSON() as Submission;
          state.posts.push(input);
          const loss = state.loseNext;
          state.loseNext = null;
          if (loss === "missing") return route.abort("connectionfailed");
          const existing = [...state.runs.values()].find(
            (item) =>
              item.conversation_id === current.id &&
              item.client_message_id === input.client_message_id,
          );
          if (existing) return respond(202, existing);
          if (current.active_run_id) return error(409, "conversation_busy");
          const run = accept(current.id, input);
          if (loss === "accepted") return route.abort("connectionfailed");
          return respond(202, run);
        }
        const before = Number(url.searchParams.get("before_seq") ?? Infinity);
        if (Number.isFinite(before)) state.beforeSeqs.push(before);
        const all = state.messages.get(current.id)!.filter((item) => item.seq < before),
          items = all.slice(-50);
        return respond(200, { items, has_more: all.length > items.length });
      }
      return respond(200, current);
    }
    if (segments[3] === "runs") {
      const run = state.runs.get(segments[4]);
      if (!run) return error(404, "run_not_found");
      if (segments[5] === "cancel") {
        state.cancelCalls++;
        if (["pending", "running"].includes(run.status))
          finish(run, "cancelled", assistant(run).content);
        return respond(200, run);
      }
      if (segments[5] === "events") {
        if (state.rejectEvents > 0) {
          state.rejectEvents--;
          return error(401, "invalid_local_token");
        }
        return route.continue({ url: `http://127.0.0.1:${address.port}${path}` });
      }
      const captured = structuredClone(run);
      if (state.runReadDelayMs) {
        state.delayedReadsStarted++;
        await new Promise((resolve) => setTimeout(resolve, state.runReadDelayMs));
        state.delayedReadsFinished++;
      }
      return respond(200, captured);
    }
    return error(404, "http_error");
  });
  return {
    state,
    conversation,
    seedHistory,
    finish,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export type ChatMock = Awaited<ReturnType<typeof mockChat>>;
export const test = base.extend<{ chat: ChatMock }>({
  chat: async ({ page }, provide) => {
    const chat = await mockChat(page);
    try {
      await provide(chat);
    } finally {
      await chat.close();
    }
  },
});
export { expect };
