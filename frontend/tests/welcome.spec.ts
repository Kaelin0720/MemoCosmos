import { test, expect, frontendOrigin, type Page } from "./test";
import { fixtureNote, mockNotes } from "./notes-fixture";
import { mockMemory } from "./memory-fixture";
import { ONBOARDING_STORAGE_KEY, LANGUAGE_STORAGE_KEY, PRODUCT_NAME } from "../src/lib/product";

test.use({ welcomeCompleted: false });
async function fresh(page: Page, seed = [] as ReturnType<typeof fixtureNote>[]) {
  const notes = await mockNotes(page, seed);
  notes.tags.tags = [];
  const memory = await mockMemory(page);
  await page.route("http://127.0.0.1:8009/api/v1/conversations**", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": frontendOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: [], total: 0 }),
    }),
  );
  return { notes, memory };
}
async function capture(page: Page, path: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}

test("空库首次从每个主要入口进入欢迎页，检查过程只有读取请求", async ({ page }) => {
  const { notes, memory } = await fresh(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (/\/api\//.test(request.url()) && !["GET", "OPTIONS"].includes(request.method()))
      writes.push(request.url());
  });
  for (const route of ["/", "/knowledge/", "/tags/", "/settings/"]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/welcome\/$/);
    await expect(
      page.getByRole("heading", { name: "欢迎建造你的记忆宇宙", exact: true }),
    ).toBeVisible();
  }
  await expect(page.locator(".welcome-brand")).toHaveText(PRODUCT_NAME);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_STORAGE_KEY),
  ).toBeNull();
  expect(notes.posts).toBe(0);
  expect(memory.actions).toEqual([]);
  expect(writes).toEqual([]);
});

test("欢迎页切语言即时预览，刷新保留，继续设置后无需 Key 可进知识库并重看欢迎", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { notes, memory } = await fresh(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "English", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("heading", { name: "Welcome to your memory universe", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page).toHaveTitle(`${PRODUCT_NAME} · Second brain`);
  await page.reload();
  await expect(page.getByRole("button", { name: "English", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await capture(page, "previews/27-welcome-desktop.png");
  await page.getByRole("button", { name: "Begin building", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/\?setup=1$/);
  await expect(
    page.getByRole("heading", { name: "Next, choose your cloud model", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("API URL", { exact: true })).toHaveValue("");
  await expect(page.locator("#model-key")).toHaveValue("");
  await page
    .locator(".setup-guide")
    .getByRole("link", { name: "Explore your library first", exact: true })
    .click();
  await expect(page).toHaveURL(/\/knowledge\/$/);
  expect(await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_STORAGE_KEY)).toBe(
    "complete",
  );
  await expect(page.locator(".notes-heading h1")).toHaveText("Notes");
  await page.reload();
  await expect(page.locator(".notes-heading h1")).toHaveText("Notes");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Revisit welcome", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome to your memory universe", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "欢迎建造你的记忆宇宙", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "先进入知识库", exact: true }).click();
  await expect(page.locator(".notes-heading h1")).toHaveText("主题文档");
  expect(await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_STORAGE_KEY)).toBe(
    "complete",
  );
  expect(notes.posts).toBe(0);
  expect(notes.patches).toEqual([]);
  expect(memory.actions).toEqual([]);
  expect(errors).toEqual([]);
});

test("直接进入知识库也完成欢迎，后续任意入口与刷新不会重复", async ({ page }) => {
  await fresh(page);
  await page.goto("/welcome/");
  await page.getByRole("button", { name: "先进入知识库", exact: true }).click();
  for (const route of ["/knowledge/", "/settings/", "/tags/", "/"]) {
    await page.goto(route);
    await expect(page.locator(".app-header")).toBeVisible();
    await expect(page.locator(".welcome-screen")).toHaveCount(0);
  }
  await page.reload();
  await expect(page.locator(".app-header")).toBeVisible();
  await expect(page.locator(".welcome-screen")).toHaveCount(0);
});

test("已有文档的用户保留原文深链接，欢迎迁移不修改记忆", async ({ page }) => {
  const note = fixtureNote("既有知识", "这份原文在升级之前就已经存在。");
  const { notes } = await fresh(page, [note]);
  await page.goto(`/knowledge/?note=${note.id}`);
  await expect(page.locator(".note-reader > header h2")).toHaveText("既有知识");
  await expect(page).toHaveURL(new RegExp(`note=${note.id}`));
  await expect(page.locator(".welcome-screen")).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_STORAGE_KEY)).toBe(
    "complete",
  );
  expect(notes.posts).toBe(0);
  expect(notes.patches).toEqual([]);
});

test("已有模型配置的用户直接进入原页面，沿用旧语言偏好", async ({ page }) => {
  await fresh(page);
  await page.addInitScript(() => localStorage.setItem("yihe.interface-language", "en"));
  await page.route("http://127.0.0.1:8009/api/v1/agent/status", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": frontendOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        configured: true,
        provider: "openai_compatible",
        model: "existing-model",
        base_url: "https://existing.invalid/v1",
        has_api_key: true,
        source: "file",
        reason: null,
        tools: ["list_tags"],
        context_max_chars: 32000,
        context_max_turns: 12,
      }),
    }),
  );
  await page.goto("/settings/");
  await expect(page.getByLabel("Model name", { exact: true })).toHaveValue("existing-model");
  await expect(page.locator(".welcome-screen")).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), LANGUAGE_STORAGE_KEY)).toBe("en");
  expect(await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_STORAGE_KEY)).toBe(
    "complete",
  );
});

test("服务不可达时保留恢复入口，也可主动打开欢迎页", async ({ page }) => {
  await page.goto("/settings/");
  await expect(
    page.getByRole("heading", { name: "让这个空间更适合你", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".welcome-screen")).toHaveCount(0);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_STORAGE_KEY),
  ).toBeNull();
  await page.getByRole("link", { name: "重看欢迎页", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "欢迎建造你的记忆宇宙", exact: true }),
  ).toBeVisible();
});

test("手机欢迎页保持可读且遵循系统减少动画，键盘可以选择语言", async ({ page }) => {
  await fresh(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/welcome/");
  await expect(page.getByRole("switch", { name: "减少动画", exact: true })).toBeDisabled();
  await expect(page.locator(".nebula-image")).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "English", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Welcome to your memory universe", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await capture(page, "previews/28-welcome-mobile.png");
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
