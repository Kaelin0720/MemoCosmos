import { PRODUCT_NAME } from "../src/lib/product";
import { test, expect } from "./test";
import { fixtureTag, mockApi } from "./api-fixture";

test("工作台入口、键盘导航和真实功能入口", async ({ page }) => {
  await mockApi(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "新的对话" })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /切换空间/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "工作台", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "标签池", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tags\/$/);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "快速前往" })).toBeVisible();
  await page.getByLabel("搜索空间").fill("知识");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/knowledge\/$/);
  await expect(page.getByRole("heading", { name: "主题文档", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "能力中心" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("减少动画在空间切换后保留，并遵循系统设置", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text()))
      hydrationErrors.push(message.text());
  });
  await mockApi(page);
  await page.goto("/settings/");
  const toggle = page.getByRole("switch", { name: "减少动画" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".nebula-image")).toHaveCSS("animation-name", "none");
  await page.getByRole("link", { name: `${PRODUCT_NAME}，返回工作台` }).click();
  await expect(page.locator(".light-flow")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/settings/");
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(hydrationErrors).toEqual([]);
});

test("手机上的标签操作与空间菜单可用，没有横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, [fixtureTag("长标签名称".repeat(8), "描述".repeat(100))]);
  await page.goto("/tags/");
  await expect(page.getByRole("button", { name: /操作标签/ })).toBeVisible();
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(await overflow()).toBe(false);
  await page.getByRole("button", { name: "新增标签", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "新增标签" })).toBeVisible();
  expect(await overflow()).toBe(false);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /切换空间/ }).click();
  await page.getByRole("menuitem", { name: "工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "新的对话" })).toBeVisible();
  expect(await overflow()).toBe(false);
});
