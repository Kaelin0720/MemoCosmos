import { test, expect, emptyStatus } from "./chat-fixture";

test("缺配置引导设置，不预填厂商或模型，保存后清空密钥且空输入沿用", async ({ page, chat }) => {
  chat.state.status = { ...emptyStatus };
  await page.goto("/");
  await page.getByLabel("消息内容").fill("尚未配置时不能发送");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: /去设置 URL/ }).click();
  const url = page.getByLabel("API URL", { exact: true }),
    model = page.getByLabel("模型名称", { exact: true }),
    key = page.locator("#model-key");
  await expect(url).toHaveValue("");
  await expect(model).toHaveValue("");
  await expect(key).toHaveValue("");
  await url.fill("https://user-model.invalid/v1");
  await model.fill("user-chosen-model");
  await key.fill("fixture-secret-123");
  await page.getByRole("button", { name: "保存模型配置" }).click();
  await expect(key).toHaveValue("");
  await expect(page.getByText("配置已齐全，可在会话中验证连接", { exact: false })).toBeVisible();
  expect(chat.state.posts).toHaveLength(0);
  expect(chat.state.configs[0]).toEqual({
    base_url: "https://user-model.invalid/v1",
    model: "user-chosen-model",
    api_key: "fixture-secret-123",
  });
  await model.fill("another-user-model");
  await page.getByRole("button", { name: "保存模型配置" }).click();
  await expect(model).toHaveValue("another-user-model");
  expect(chat.state.configs[1]).toEqual({
    base_url: "https://user-model.invalid/v1",
    model: "another-user-model",
  });
  expect(chat.state.statusReads).toBe(2);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain("fixture-secret-123");
  expect(await page.locator("body").innerText()).not.toContain("fixture-secret-123");
  await page.reload();
  await expect(key).toHaveValue("");
  await expect(model).toHaveValue("another-user-model");
});

test("URL 凭据拒绝发送，保存网络失败不会回显密钥或自动再发", async ({ page, chat }) => {
  await page.goto("/settings/");
  await page
    .getByLabel("API URL", { exact: true })
    .fill("https://username:password@model.invalid/v1?key=unsafe");
  await page.locator("#model-key").fill("fixture-do-not-echo");
  await page.getByRole("button", { name: "保存模型配置" }).click();
  await expect(page.locator(".model-settings [role=alert]")).toContainText("不能包含账号、密码");
  expect(chat.state.configs).toHaveLength(0);
  await page.getByLabel("API URL", { exact: true }).fill("https://model.invalid/v1");
  chat.state.offline = true;
  await page.getByRole("button", { name: "保存模型配置" }).click();
  await expect(page.locator(".model-settings [role=alert]")).toContainText("配置保存未确认");
  expect(await page.locator("body").innerText()).not.toContain("fixture-do-not-echo");
  expect(chat.state.configs).toHaveLength(0);
});

test("保存完成后的新配置不被较早的慢状态读取覆盖", async ({ page, chat }) => {
  chat.state.status = { ...emptyStatus };
  await page.goto("/settings/");
  await expect(page.getByLabel("API URL", { exact: true })).toBeEnabled();
  chat.state.statusReadDelayMs = 1500;
  await page.getByRole("button", { name: "刷新配置状态" }).click();
  await expect.poll(() => chat.state.delayedStatusesStarted).toBe(1);
  await page.getByLabel("API URL", { exact: true }).fill("https://model.invalid/v1");
  await page.getByLabel("模型名称", { exact: true }).fill("new-config-during-read");
  await page.locator("#model-key").fill("race-test-only-secret");
  await page.getByRole("button", { name: "保存模型配置" }).click();
  await expect(page.getByText("配置已齐全，可在会话中验证连接", { exact: false })).toBeVisible();
  await expect.poll(() => chat.state.delayedStatusesFinished).toBe(1);
  await expect(page.getByText("配置已齐全，可在会话中验证连接", { exact: false })).toBeVisible();
  await expect(page.locator("#model-key")).toHaveValue("");
  expect(chat.state.configs).toHaveLength(1);
});
