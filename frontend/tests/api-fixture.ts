import { frontendOrigin } from "./test";
import type { Page } from "./test";
import type { Tag } from "../src/lib/api";

export function fixtureTag(name: string, description = ""): Tag {
  return {
    id: `test-${name}`,
    name,
    description,
    created_by: "user",
    created_at: "2026-10-10T04:00:00Z",
    updated_at: "2026-10-10T04:00:00Z",
  };
}

// Test-only service fixture. The shipped application never preloads these tags.
export async function mockApi(page: Page, seed: Tag[] = []) {
  const state = {
    tags: [...seed],
    token: "test-token-1",
    bootstrapCalls: 0,
    postCalls: 0,
    committedCreates: 0,
    offline: false,
    failWrites: false,
    rejectTokens: false,
    queries: [] as string[],
    completedQueries: [] as string[],
    delays: new Map<string, number>(),
  };
  await page.route("http://127.0.0.1:8009/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const respond = (status: number, body?: unknown) =>
      route.fulfill({
        status,
        headers: {
          "Access-Control-Allow-Origin": frontendOrigin,
          "Access-Control-Allow-Headers": "Content-Type,X-Local-Token",
          "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const fail = (status: number, code: string, message: string) =>
      respond(status, { error: { code, message } });
    if (state.offline) return route.abort("connectionrefused");
    if (method === "OPTIONS") return respond(204);
    if (url.pathname === "/health") return respond(200, { status: "ok" });
    if (url.pathname === "/api/v1/bootstrap") {
      state.bootstrapCalls++;
      return respond(200, { local_token: state.token });
    }
    if (method === "POST") state.postCalls++;
    if (state.rejectTokens || request.headers()["x-local-token"] !== state.token)
      return fail(401, "invalid_local_token", "本机会话令牌已失效");
    if (state.failWrites && method !== "GET") return route.abort("connectionfailed");
    if (url.pathname === "/api/v1/memory/settings") return respond(200, { auto_memory: true });
    if (url.pathname === "/api/v1/memory/jobs") return respond(200, { items: [], total: 0 });
    if (url.pathname === "/api/v1/memory/graph") return respond(200, { nodes: [], edges: [] });
    if (url.pathname === "/api/v1/memory/search")
      return respond(200, { items: [], total: 0, truncated: false });
    if (url.pathname === "/api/v1/agent/status")
      return respond(200, {
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
      });
    if (method === "GET") {
      const query = url.searchParams.get("q") ?? "";
      state.queries.push(query);
      const delay = state.delays.get(query);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const items = state.tags.filter((tag) =>
        `${tag.name} ${tag.description}`.toLowerCase().includes(query.toLowerCase()),
      );
      state.completedQueries.push(query);
      return respond(200, { items, total: items.length });
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (method === "DELETE") {
      if (!state.tags.some((tag) => tag.id === id)) return fail(404, "tag_not_found", "标签不存在");
      state.tags = state.tags.filter((tag) => tag.id !== id);
      return respond(204);
    }
    const input = request.postDataJSON() as { name: string; description: string };
    if (
      state.tags.some(
        (tag) =>
          tag.name.toLowerCase() === input.name.trim().toLowerCase() &&
          (method === "POST" || tag.id !== id),
      )
    )
      return fail(409, "duplicate_tag", "标签名称已存在");
    if (method === "POST") {
      const tag = {
        ...fixtureTag(input.name.trim(), input.description),
        id: `created-${state.committedCreates++}`,
      };
      state.tags.push(tag);
      return respond(201, tag);
    }
    const existing = state.tags.find((tag) => tag.id === id);
    if (!existing) return fail(404, "tag_not_found", "标签不存在");
    Object.assign(existing, input, { updated_at: "2026-10-10T05:00:00Z" });
    return respond(200, existing);
  });
  return state;
}
