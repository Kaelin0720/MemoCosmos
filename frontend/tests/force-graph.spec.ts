import { test, expect } from "./chat-fixture";
import { fixtureNote, mockNotes } from "./notes-fixture";
import { mockMemory } from "./memory-fixture";
import type { Page } from "./test";

async function explore(page: Page) {
  await mockNotes(page);
  await mockMemory(page);
  await page.goto("/knowledge/?view=graph&mode=explore");
  const canvas = page.locator(".force-graph");
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute("data-motion-state", "moving");
  await expect(canvas.locator(".graph-node")).toHaveCount(14);
  return canvas;
}
async function positions(page: Page) {
  return page.locator(".graph-node").evaluateAll((elements) =>
    elements.map((element) => {
      const matrix = (element as SVGGElement).transform.baseVal.consolidate()!.matrix;
      return { id: element.getAttribute("data-node-id")!, x: matrix.e, y: matrix.f };
    }),
  );
}
async function point(page: Page, id: string) {
  return page.locator(`.graph-node[data-node-id="${id}"]`).evaluate((element) => {
    const matrix = (element as SVGGraphicsElement).getScreenCTM()!;
    const result = new DOMPoint(0, 0).matrixTransform(matrix);
    return { x: result.x, y: result.y };
  });
}
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

test("白色半透明圆点按邻居数变化，节点持续独立运动且选择与悬浮保留运动", async ({ page }) => {
  const canvas = await explore(page);
  const hub = canvas.locator('[data-node-id="explore-2"]');
  const leaf = canvas.locator('[data-node-id="explore-6"]');
  expect(Number(await hub.getAttribute("data-weight"))).toBeGreaterThan(
    Number(await leaf.getAttribute("data-weight")),
  );
  expect(Number(await hub.locator(".graph-core").getAttribute("r"))).toBeGreaterThan(
    Number(await leaf.locator(".graph-core").getAttribute("r")),
  );
  await expect(leaf.locator(".graph-core")).toHaveCSS("fill", "rgb(255, 255, 255)");
  const opacity = Number(
    await leaf.locator(".graph-core").evaluate((element) => getComputedStyle(element).fillOpacity),
  );
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  await expect(canvas.locator("circle.graph-core")).toHaveCount(14);
  await page.waitForTimeout(600);
  const before = await positions(page);
  await page.waitForTimeout(1000);
  const after = await positions(page);
  expect(after.every((p, i) => distance(p, before[i]) > 0.01)).toBe(true);
  const deformation = before
    .slice(1)
    .map((p, i) => Math.abs(distance(before[0], p) - distance(after[0], after[i + 1])));
  expect(Math.max(...deformation)).toBeGreaterThan(0.05);
  // Direct neighbors of RAG: tags, chunking, keyword search.
  const hover = await point(page, "explore-5");
  await page.mouse.move(hover.x, hover.y);
  await expect(canvas.locator(".graph-node.highlighted")).toHaveCount(4);
  expect(
    await canvas
      .locator(".graph-node.highlighted")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-node-id")).sort(),
      ),
  ).toEqual(["explore-3", "explore-5", "explore-6", "explore-7"]);
  await expect(canvas.locator(".graph-edge.highlighted")).toHaveCount(3);
  await expect(canvas).toHaveAttribute("data-motion-state", "moving");
  const held = await positions(page);
  await page.waitForTimeout(350);
  expect(await positions(page)).not.toEqual(held);
  await leaf.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".graph-details h3")).toHaveText("切片策略");
  await expect(canvas).toHaveAttribute("data-motion-state", "moving");
});

test("缩放后的拖拽匹配指针，只固定当前节点；画布平移、暂停和复位可用", async ({ page }) => {
  const canvas = await explore(page);
  await page.getByRole("button", { name: "放大星图" }).click();
  await expect(canvas.locator(".graph-network")).toHaveAttribute("transform", /scale\(1\.15\)/);
  const origin = await point(page, "explore-0");
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await expect(canvas.locator('[data-node-id="explore-0"]')).toHaveClass(/dragging/);
  const grabbed = await point(page, "explore-0");
  await page.mouse.move(origin.x + 45, origin.y + 20, { steps: 5 });
  const pinned = await point(page, "explore-0");
  expect(pinned.x - grabbed.x).toBeCloseTo(45, 0);
  expect(pinned.y - grabbed.y).toBeCloseTo(20, 0);
  const other = await point(page, "explore-1");
  await page.waitForTimeout(500);
  expect(distance(await point(page, "explore-0"), pinned)).toBeLessThan(0.01);
  expect(distance(await point(page, "explore-1"), other)).toBeGreaterThan(0.02);
  await expect(canvas).toHaveAttribute("data-motion-state", "moving");
  await page.mouse.up();
  await expect(canvas.locator('[data-node-id="explore-0"]')).not.toHaveClass(/dragging/);
  await page.getByRole("button", { name: "暂停运动", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-motion-state", "paused");
  const paused = await positions(page);
  await page.waitForTimeout(300);
  expect(await positions(page)).toEqual(paused);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 38, box.y + 28, { steps: 5 });
  await page.mouse.up();
  await expect(canvas.locator(".graph-network")).toHaveAttribute("transform", /translate/);
  const beforeWheel = await canvas.locator(".graph-network").getAttribute("transform");
  await page.mouse.wheel(0, -80);
  await expect(canvas.locator(".graph-network")).not.toHaveAttribute("transform", beforeWheel!);
  await page.getByRole("button", { name: "复位星图", exact: true }).click();
  await expect(canvas.locator(".graph-network")).toHaveAttribute(
    "transform",
    "translate(0,0) scale(1)",
  );
  await expect(canvas).toHaveAttribute("data-motion-state", "paused");
  await page.getByRole("button", { name: "继续运动", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-motion-state", "moving");
});

test("后台、全局弹窗与减少动画暂停，返回后继续运动", async ({ page }) => {
  const canvas = await explore(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(canvas).toHaveAttribute("data-motion-state", "paused");
  const hidden = await positions(page);
  await page.waitForTimeout(250);
  expect(await positions(page)).toEqual(hidden);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(canvas).toHaveAttribute("data-motion-state", "moving");
  await page.locator(".command-trigger").click();
  await expect(page.locator(".command-dialog")).toBeVisible();
  await expect(canvas).toHaveAttribute("data-motion-state", "paused");
  const dialog = await positions(page);
  await page.waitForTimeout(250);
  expect(await positions(page)).toEqual(dialog);
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-motion-state", "moving");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(canvas).toHaveAttribute("data-motion-state", "paused");
  await expect(page.locator(".graph-motion-control")).toBeDisabled();
  const reduced = await positions(page);
  await page.waitForTimeout(250);
  expect(await positions(page)).toEqual(reduced);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(canvas).toHaveAttribute("data-motion-state", "moving");
});

test("语言切换延续位置，缩放后的所有标签保持屏幕字号", async ({ page }) => {
  await explore(page);
  await page.getByRole("button", { name: "暂停运动", exact: true }).click();
  await page.getByRole("button", { name: "放大星图" }).click();
  const before = await positions(page);
  await page.locator(".language-trigger").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
  await expect(page.locator(".graph-details h3")).toHaveText("Second brain");
  expect(await positions(page)).toEqual(before);
  const sizes = await page.locator(".graph-node text").evaluateAll((elements) =>
    elements.map((element) => {
      const matrix = (element as SVGGraphicsElement).getScreenCTM()!;
      return parseFloat(getComputedStyle(element).fontSize) * Math.hypot(matrix.a, matrix.b);
    }),
  );
  sizes.forEach((size) => expect(size).toBeCloseTo(12, 1));
  await expect(page.getByRole("button", { name: "Resume motion", exact: true })).toBeVisible();
});

test("手机默认动态，每颗星点标签可见可读，并可手动暂停", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const canvas = await explore(page);
  const dimensions = await canvas.evaluate((element) => ({
    width: element.clientWidth,
    viewBox: (element as SVGSVGElement).viewBox.baseVal.width,
  }));
  expect(dimensions.viewBox).toBe(dimensions.width);
  const labels = await canvas.locator(".graph-node text").evaluateAll((elements) =>
    elements.map((element) => {
      const matrix = (element as SVGGraphicsElement).getScreenCTM()!;
      const style = getComputedStyle(element);
      return {
        display: style.display,
        size: parseFloat(style.fontSize) * Math.hypot(matrix.a, matrix.b),
      };
    }),
  );
  expect(labels).toHaveLength(14);
  labels.forEach((label) => {
    expect(label.display).toBe("block");
    expect(label.size).toBeCloseTo(12, 1);
  });
  await expect(page.locator(".graph-motion-control")).toBeVisible();
  await expect(page.locator(".graph-motion-control")).toBeEnabled();
  const before = await positions(page);
  await page.waitForTimeout(500);
  expect(await positions(page)).not.toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByRole("button", { name: "暂停运动", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-motion-state", "paused");
  const clipped = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll(".graph-node text"))
      .filter((label) => {
        const box = label.getBoundingClientRect();
        return (
          box.left < bounds.left ||
          box.right > bounds.right ||
          box.top < bounds.top ||
          box.bottom > bounds.bottom
        );
      })
      .map((label) => label.textContent);
  });
  expect(clipped).toEqual([]);
  await capture(page, "previews/26-d3-graph-mobile.png");
});

test("刷新真实关系图保留同一节点坐标，并延续原始文档与证据", async ({ page }) => {
  const first = fixtureNote(),
    second = fixtureNote("项目 A");
  const notes = await mockNotes(page, [first, second]);
  const memory = await mockMemory(page);
  memory.graph = {
    nodes: [first, second],
    edges: [
      {
        id: "refresh-edge",
        source: first.id,
        target: second.id,
        relation: "应用",
        evidence: "项目 A 使用 Redis 缓存",
        source_message_id: null,
        created_at: first.created_at,
      },
    ],
  };
  await page.goto("/knowledge/?view=graph");
  const canvas = page.locator(".force-graph");
  await expect(canvas.locator(".graph-node")).toHaveCount(2);
  await page.getByRole("button", { name: "暂停运动", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-motion-state", "paused");
  const before = await positions(page);
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/memory/graph")),
    page.getByRole("button", { name: "刷新关系", exact: true }).click(),
  ]);
  await expect(page.getByRole("button", { name: "刷新关系", exact: true })).toBeEnabled();
  expect(await positions(page)).toEqual(before);
  // The constellation line stays easy to select away from the narrow visible stroke.
  const connection = await canvas.locator(".graph-edge-hit").evaluate((element) => {
    const line = element as SVGLineElement,
      matrix = line.getScreenCTM()!;
    const mid = new DOMPoint(line.x2.baseVal.value / 2, 0).matrixTransform(matrix);
    const scale = Math.hypot(matrix.a, matrix.b);
    return { x: mid.x - (matrix.b / scale) * 4, y: mid.y + (matrix.a / scale) * 4 };
  });
  await page.mouse.click(connection.x, connection.y);
  await expect(page.locator(".graph-evidence")).toContainText("项目 A 使用 Redis 缓存");
  await canvas.getByRole("button", { name: "选择节点 Redis 缓存", exact: true }).click();
  await page.getByRole("button", { name: "应用 · 项目 A", exact: true }).click();
  await expect(page.locator(".graph-evidence")).toContainText("项目 A 使用 Redis 缓存");
  await page.getByRole("button", { name: "阅读关联文档", exact: true }).click();
  await expect(page.locator(".note-reader > header h2")).toHaveText("项目 A");
  expect(notes.patches).toEqual([]);
  expect(memory.actions).toEqual([]);
});

test("画布离开视口会暂停，自动暂停保留手动暂停按钮的意图", async ({ page }) => {
  const canvas = await explore(page);
  await canvas.evaluate((element) => {
    (element as SVGSVGElement).style.transform = "translateY(-2000px)";
  });
  await expect(canvas).toHaveAttribute("data-motion-state", "paused");
  const held = await positions(page);
  await page.waitForTimeout(250);
  expect(await positions(page)).toEqual(held);
  await expect(page.getByRole("button", { name: "暂停运动", exact: true })).toBeVisible();
  await canvas.evaluate((element) => {
    (element as SVGSVGElement).style.transform = "";
  });
  await expect(canvas).toHaveAttribute("data-motion-state", "moving");
  await page.getByRole("button", { name: "暂停运动", exact: true }).click();
  await canvas.evaluate((element) => {
    (element as SVGSVGElement).style.transform = "translateY(-2000px)";
  });
  await page.waitForTimeout(150);
  await canvas.evaluate((element) => {
    (element as SVGSVGElement).style.transform = "";
  });
  await expect(canvas).toHaveAttribute("data-motion-state", "paused");
  await expect(page.getByRole("button", { name: "继续运动", exact: true })).toBeVisible();
});

async function capture(page: Page, path: string) {
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}

test("深空主题在会话、文档、星图和设置中一致，并保留可读输入与手机布局", async ({ page, chat }) => {
  test.setTimeout(60000);
  const first = fixtureNote(
    "检索策略",
    "## 语义切片\n\n按标题与语义拆分文档，保留上下文。\n\n## 知识连接\n\n回顾项目经验，沿着关联找到相关主题。",
  );
  const second = fixtureNote("项目复盘", "## 学习记录\n\n知识积累与实践相互连接。");
  first.folder = "知识/检索";
  second.folder = "工作/项目";
  await mockNotes(page, [first, second]);
  await mockMemory(page);
  chat.state.status.configured = true;
  await page.goto("/");
  await expect(page.locator("#chat-input")).toBeVisible();
  await expect(page.locator(".chat-window")).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(11, 11, 18)");
  await capture(page, "previews/20-cosmos-workbench.png");
  await page.goto(`/knowledge/?note=${first.id}`);
  await expect(page.locator(".note-reader h2").first()).toHaveText("检索策略");
  await capture(page, "previews/21-cosmos-documents.png");
  await page.getByRole("button", { name: "关系星图", exact: true }).click();
  await page.getByRole("button", { name: "探索星图", exact: true }).first().click();
  await expect(page.locator(".graph-node")).toHaveCount(14);
  await page.getByRole("button", { name: "暂停运动", exact: true }).click();
  await capture(page, "previews/25-d3-graph-desktop.png");
  await page.goto("/settings/");
  await expect(page.getByLabel("模型名称", { exact: true })).toBeVisible();
  await capture(page, "previews/23-cosmos-settings.png");
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/knowledge/?view=graph&mode=explore");
  await expect(page.locator(".graph-node")).toHaveCount(14);
  await expect(page.locator(".memory-graph")).toBeVisible();
  await expect(page.locator(".graph-details h3")).toHaveText("第二大脑");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.waitForTimeout(450);
  await capture(page, "previews/24-cosmos-mobile.png");
});
