import { frontendOrigin } from "./test";
import { randomUUID } from "node:crypto";
import type { Page } from "./test";
import type { MemoryJob, MemoryGraph, MemoryHit } from "../src/lib/memory-types";
export function fixtureJob(status: MemoryJob["status"]): MemoryJob {
  return {
    id: randomUUID(),
    conversation_id: randomUUID(),
    run_id: randomUUID(),
    user_message_id: randomUUID(),
    status,
    reason: "测试任务建议",
    question: status === "needs_confirmation" ? "这是已经完成的行动吗？" : "",
    error: null,
    notes: [],
    created_at: "2026-10-11T04:00:00Z",
    updated_at: "2026-10-11T04:00:00Z",
  };
}
export async function mockMemory(page: Page) {
  const state = {
    jobs: [] as MemoryJob[],
    graph: { nodes: [], edges: [] } as MemoryGraph,
    hits: [] as MemoryHit[],
    searches: [] as string[],
    reads: 0,
    actions: [] as { id: string; path: string; input: Record<string, unknown> }[],
    auto: true,
    settingsWrites: 0,
    imports: [] as { type: string; body: Buffer }[],
    importUnknown: false,
  };
  await page.route("http://127.0.0.1:8009/api/v1/memory/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const respond = (body: unknown) =>
      route.fulfill({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": frontendOrigin,
          "Access-Control-Allow-Headers": "X-Local-Token,Content-Type",
          "Access-Control-Allow-Methods": "GET,POST,PUT",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": frontendOrigin,
          "Access-Control-Allow-Headers": "X-Local-Token,Content-Type",
          "Access-Control-Allow-Methods": "GET,POST,PUT",
        },
      });
    if (path.endsWith("/settings")) {
      if (request.method() === "PUT") {
        state.settingsWrites++;
        state.auto = request.postDataJSON().auto_memory;
      }
      return respond({ auto_memory: state.auto });
    }
    if (path.endsWith("/graph")) return respond(state.graph);
    if (path.endsWith("/search")) {
      state.searches.push(url.search);
      return respond({ items: state.hits, total: state.hits.length, truncated: false });
    }
    if (path.endsWith("/export"))
      return route.fulfill({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": frontendOrigin,
          "Content-Type": "application/zip",
        },
        body: Buffer.from([80, 75, 3, 4, 0, 1, 2, 3]),
      });
    if (path.endsWith("/import")) {
      state.imports.push({
        type: request.headers()["content-type"],
        body: request.postDataBuffer()!,
      });
      if (state.importUnknown) return route.abort("connectionfailed");
      return respond({
        memory_dir: "/tmp/只读测试恢复目录",
        requires_restart: true,
        message: "测试包已恢复到独立目录。",
      });
    }
    if (path.endsWith("/jobs")) {
      state.reads++;
      return respond({ items: state.jobs, total: state.jobs.length });
    }
    const id = path.split("/")[5],
      job = state.jobs.find((job) => job.id === id);
    if (!job) return route.fulfill({ status: 404 });
    const input = request.postDataJSON();
    state.actions.push({ id, path, input });
    Object.assign(job, {
      status: input.action === "dismiss" ? "skipped" : "completed",
      updated_at: "2026-10-11T04:01:00Z",
    });
    return respond(job);
  });
  return state;
}
