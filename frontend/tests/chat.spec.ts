import { test, expect } from "./chat-fixture";

async function send(page: import("@playwright/test").Page, text = "请帮我理解知识之间的联系") {
  await page.getByLabel("消息内容").fill(text);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

test("中文字节流、安全 Markdown、标题链接、快照完成与重复点击", async ({ page, chat }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  chat.state.chunkSize = 1;
  chat.state.chunkDelayMs = 1;
  chat.state.rejectEvents = 1;
  chat.state.reply =
    '## 中文标题\n\n逐字节中文🌌，完整回复。\n\n[## 官方资料](https://example.com/docs) [# 本地文档](notes/test.md)\n\n<script>window.__unsafe = true</script>\n\n[危险链接](javascript:alert(1)) ![外部图片](https://image.invalid/private.png)\n\n```html\n<img onerror="alert(1)">\n```';
  await page.goto("/");
  await page.getByLabel("消息内容").fill("  保留原始空白与中文🌌  ");
  await page.getByRole("button", { name: "发送消息", exact: true }).dblclick();
  await expect(page.getByRole("heading", { name: "中文标题" })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0, { timeout: 20000 });
  await expect(page.getByRole("link", { name: "官方资料", exact: true })).toHaveAttribute(
    "href",
    "https://example.com/docs",
  );
  await expect(page.locator(".unavailable-link", { hasText: "本地文档" })).toHaveText("本地文档");
  await expect(page.getByRole("link", { name: "危险链接" })).toHaveCount(0);
  expect(await page.evaluate(() => "__unsafe" in window)).toBe(false);
  await expect(page.locator(".chat-markdown img, .chat-markdown script")).toHaveCount(0);
  expect(chat.state.posts).toHaveLength(1);
  expect(chat.state.posts[0].content).toBe("  保留原始空白与中文🌌  ");
  expect(chat.state.bootstrapCalls).toBe(2);
  expect(chat.state.eventCalls).toBe(1);
  await expect(page.getByRole("article", { name: "用户消息", exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("聊天流超过标签八秒超时仍可完成", async ({ page, chat }) => {
  chat.state.delayMs = 9300;
  await page.goto("/");
  await send(page);
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await page.waitForTimeout(8300);
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible({
    timeout: 5000,
  });
  expect(chat.state.eventCalls).toBe(1);
  expect(chat.state.posts).toHaveLength(1);
  await expect(page.locator(".workbench [role=alert]")).toHaveCount(0);
});

test("停止调用取消接口，部分回复和原文在刷新后保留", async ({ page, chat }) => {
  chat.state.mode = "hold";
  await page.goto("/");
  await send(page, "停止测试的原文");
  await expect(page.locator(".chat-markdown")).toHaveText(chat.state.partial);
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByText("已停止 · 已保留回复片段")).toBeVisible();
  expect(chat.state.cancelCalls).toBe(1);
  expect(chat.state.posts).toHaveLength(1);
  await page.reload();
  await expect(page.locator(".chat-markdown")).toHaveText(chat.state.partial);
  await expect(page.getByRole("article", { name: "用户消息", exact: true })).toHaveText(
    "停止测试的原文",
  );
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
});

test("断流重连用快照替换，恢复中文不重复生成或重复片段", async ({ page, chat }) => {
  chat.state.mode = "recover";
  await page.goto("/");
  await send(page);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByRole("heading", { name: "中文回复" })).toHaveCount(1);
  await expect(page.getByText("星图里的知识，正在形成联系。🌌", { exact: true })).toHaveCount(1);
  expect(chat.state.eventCalls).toBe(2);
  expect(chat.state.posts).toHaveLength(1);
  expect(chat.state.cancelCalls).toBe(0);
});

for (const mode of ["failed", "interrupted", "disconnect"] as const) {
  test(`${mode} 保留原文和部分回复，并查询真实运行状态`, async ({ page, chat }) => {
    chat.state.mode = mode;
    await page.goto("/");
    await send(page, "这条原文需要保留");
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByRole("article", { name: "用户消息", exact: true })).toHaveText(
      "这条原文需要保留",
    );
    if (mode === "disconnect")
      await expect(page.getByRole("heading", { name: "中文回复" })).toBeVisible();
    else {
      await expect(page.locator(".chat-markdown")).toHaveText(chat.state.partial);
      await expect(
        page.getByText(
          mode === "failed" ? "生成失败 · 已保留回复片段" : "运行已中断 · 已保留回复片段",
        ),
      ).toBeVisible();
      if (mode === "failed") {
        await expect(page.locator(".workbench [role=alert]")).toContainText(
          "云端模型暂时无法完成请求",
        );
        await expect(page.locator(".chat-markdown")).not.toContainText("云端模型暂时");
      }
    }
    expect(chat.state.posts).toHaveLength(1);
    expect(chat.state.cancelCalls).toBe(0);
    await page.reload();
    await expect(page.getByRole("article", { name: "用户消息", exact: true })).toHaveCount(1);
  });
}

test("提交响应丢失但已接受，先按 client_message_id 查询且不重发", async ({ page, chat }) => {
  chat.state.loseNext = "accepted";
  await page.goto("/");
  await send(page, "结果不明也只接受一次");
  await expect(page.getByRole("heading", { name: "中文回复" })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  expect(chat.state.lookups).toBe(1);
  expect(chat.state.posts).toHaveLength(1);
  await expect(page.getByRole("article", { name: "用户消息", exact: true })).toHaveCount(1);
});

test("未查到提交时保留原 ID，只有用户点击才重交同一原文", async ({ page, chat }) => {
  chat.state.loseNext = "missing";
  await page.goto("/");
  await send(page, "  待核对的原始消息  ");
  await expect(page.getByRole("button", { name: "手动重新提交原消息" })).toBeEnabled();
  expect(chat.state.posts).toHaveLength(1);
  await expect(page.getByLabel("消息内容")).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "核对本次运行" }).click();
  await expect(page.getByRole("button", { name: "手动重新提交原消息" })).toBeEnabled();
  expect(chat.state.posts).toHaveLength(1);
  await page.getByRole("button", { name: "手动重新提交原消息" }).click();
  await expect(page.getByRole("heading", { name: "中文回复" })).toBeVisible();
  expect(chat.state.posts).toHaveLength(2);
  expect(chat.state.posts[1]).toEqual(chat.state.posts[0]);
  await expect(page.getByRole("article", { name: "用户消息", exact: true })).toHaveCount(1);
});

test("历史会话分页、加载更早消息和 URL 刷新恢复", async ({ page, chat }) => {
  const target = chat.seedHistory("最早会话", 52);
  for (let i = 1; i <= 54; i++) chat.seedHistory(`历史会话 ${i}`);
  await page.goto("/");
  await page.getByRole("button", { name: "会话历史" }).click();
  await expect(page.getByRole("menuitem", { name: "加载更多会话" })).toBeVisible();
  await page.getByRole("menuitem", { name: "加载更多会话" }).click();
  await page.getByRole("menuitem", { name: /最早会话/ }).click();
  await expect(page).toHaveURL(new RegExp(`conversation=${target.id}`));
  await expect(page.getByRole("button", { name: "加载更早记录" })).toBeVisible();
  await expect(page.getByText("历史消息 1", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "加载更早记录" }).click();
  await expect(page.getByText("历史消息 1", { exact: true })).toBeVisible();
  expect(chat.state.offsets).toContain(50);
  expect(chat.state.beforeSeqs).toContain(3);
  await page.reload();
  await expect(page.getByRole("heading", { name: "最早会话" })).toBeVisible();
  await expect(page.getByText("历史消息 52", { exact: true })).toBeVisible();
  expect(chat.state.posts).toHaveLength(0);
});

test("活跃会话刷新接续原运行，离线读取可重试", async ({ page, chat }) => {
  chat.state.mode = "hold";
  await page.goto("/");
  await send(page, "页面恢复测试");
  await expect(page.locator(".chat-markdown")).toHaveText(chat.state.partial);
  const url = page.url();
  chat.state.offline = true;
  await page.goto(url);
  await expect(page.getByRole("button", { name: "重新读取记录" })).toBeVisible();
  chat.state.offline = false;
  await page.getByRole("button", { name: "重新读取记录" }).click();
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  expect(chat.state.posts).toHaveLength(1);
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByText("已停止 · 已保留回复片段")).toBeVisible();
});

test("中文 IME Enter 不发送，完成输入后 Enter 才提交", async ({ page, chat }) => {
  await page.goto("/");
  const input = page.getByLabel("消息内容");
  await input.fill("中文输入法");
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        isComposing: true,
      }),
    ),
  );
  expect(chat.state.posts).toHaveLength(0);
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: "中文回复" })).toBeVisible();
  expect(chat.state.posts).toHaveLength(1);
});

test("后台慢查询不能把 SSE 已结束的运行改回生成中", async ({ page, chat }) => {
  chat.state.mode = "hold";
  await page.goto("/");
  await send(page);
  await expect(page.locator(".chat-markdown")).toHaveText(chat.state.partial);
  chat.state.runReadDelayMs = 500;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => chat.state.delayedReadsStarted).toBe(1);
  chat.finish([...chat.state.runs.values()][0]);
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect.poll(() => chat.state.delayedReadsFinished).toBeGreaterThanOrEqual(1);
  await expect.poll(() => chat.state.delayedReadsFinished).toBe(chat.state.delayedReadsStarted);
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "中文回复" })).toBeVisible();
  expect(chat.state.eventCalls).toBe(1);
  expect(chat.state.posts).toHaveLength(1);
});

test("移动端代码与表格在消息内滚动，真实裁剪状态可见", async ({ page, chat }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  chat.state.truncated = true;
  chat.state.reply = `## 长内容\n\n\`\`\`text\n${"long_content_".repeat(80)}\n\`\`\`\n\n| 字段 | 说明 |\n| --- | --- |\n| ${"列".repeat(60)} | 中文说明 |`;
  await page.goto("/");
  await send(page);
  await expect(page.getByRole("heading", { name: "长内容" })).toBeVisible();
  await expect(page.getByText(/本轮只使用了近期上下文/)).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(
    await page
      .locator(".chat-markdown pre")
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await page.getByRole("button", { name: /切换空间/ }).click();
  await expect(page.getByRole("menu")).toBeVisible();
});
