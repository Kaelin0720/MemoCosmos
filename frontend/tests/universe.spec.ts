import { test, expect } from "./chat-fixture";
import { fixtureNote, mockNotes, noteTag } from "./notes-fixture";
import { mockMemory } from "./memory-fixture";

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });
test.setTimeout(60000);
test.describe.configure({ mode: "default" });

test("真实文档构成立体星域，材质与星环可切换，刷新保留并可回到二维", async ({ page }) => {
  const core = fixtureNote("LangChain", "框架知识"),
    planet = fixtureNote("RAG", "按章节检索"),
    moon = fixtureNote("长期记忆", "本地存储");
  await mockNotes(page, [core, planet, moon]);
  const memory = await mockMemory(page);
  memory.graph = {
    nodes: [core, planet, moon].map((note, index) => ({
      id: note.id,
      title: note.title,
      folder: note.folder,
      tags: [noteTag],
      kind: index === 0 ? "star" : index === 1 ? "planet" : "moon",
      region_id: "learning",
      has_knowledge: Boolean(note.body),
    })),
    edges: [
      {
        id: "core-rag",
        source: core.id,
        target: planet.id,
        relation: "关联",
        evidence: "已确认文档引用",
        source_message_id: null,
        created_at: core.created_at,
      },
      {
        id: "rag-memory",
        source: planet.id,
        target: moon.id,
        relation: "关联",
        evidence: "已确认文档引用",
        source_message_id: null,
        created_at: core.created_at,
      },
    ],
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/knowledge/?view=graph");
  await expect(page.locator(".universe-scene")).toHaveAttribute("data-renderer", "webgl", {
    timeout: 20000,
  });
  await expect(page.locator(".universe-node-label")).toHaveCount(3);
  await page.locator(".graph-accessible-list summary").click();
  await page
    .locator(".graph-accessible-list")
    .getByRole("button", { name: "RAG", exact: true })
    .click();
  await expect(page.locator(".graph-details h3")).toHaveText("RAG");
  await page.getByRole("button", { name: /浏览外观库/ }).click();
  const dialog = page.getByRole("dialog", { name: "天体外观库" });
  await expect(dialog.locator(".celestial-style-tile")).toHaveCount(6);
  await dialog.getByRole("button", { name: "发光晶体", exact: true }).click();
  await expect(dialog.locator(".celestial-style-tile")).toHaveCount(5);
  await expect
    .poll(() =>
      dialog
        .locator(".celestial-style-tile canvas")
        .first()
        .evaluate((element) =>
          Array.from(
            (element as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 128, 128).data,
          ).some((value) => value > 0),
        ),
    )
    .toBe(true);
  await dialog.getByRole("button", { name: "极光行星", exact: true }).click();
  await page.getByLabel("星环样式", { exact: true }).selectOption("double");
  await expect(page.getByLabel("天体外观", { exact: true })).toHaveValue("aurora");
  await page.reload();
  await page.locator(".graph-accessible-list summary").click();
  await page
    .locator(".graph-accessible-list")
    .getByRole("button", { name: "RAG", exact: true })
    .click();
  await expect(page.getByLabel("天体外观", { exact: true })).toHaveValue("aurora");
  await expect(page.getByLabel("星环样式", { exact: true })).toHaveValue("double");
  await page.getByRole("button", { name: "二维图谱", exact: true }).click();
  await expect(page.locator(".force-graph .graph-node")).toHaveCount(3);
  await page.getByRole("button", { name: "打开文档", exact: true }).click();
  await expect(page.locator(".note-reader")).toContainText("按章节检索");
  expect(errors).toEqual([]);
});

test("知识正文点亮节点，空文档保持暗色，宇宙与星系可逐级返回", async ({ page }) => {
  const recorded = fixtureNote("已记录主题", "已有知识正文");
  const empty = fixtureNote("待探索主题", "");
  await mockNotes(page, [recorded, empty]);
  const memory = await mockMemory(page);
  memory.graph = {
    nodes: [recorded, empty].map((note, i) => ({
      id: note.id,
      title: note.title,
      folder: note.folder,
      tags: [noteTag],
      region_id: "learning",
      has_knowledge: i === 0,
    })),
    edges: [],
  };
  await page.goto("/knowledge/?view=graph");
  const scene = page.locator(".universe-scene");
  await expect(scene).toHaveAttribute("data-renderer", "webgl", { timeout: 20000 });
  await expect(scene).toHaveAttribute("data-level", "universe");
  await page.locator(".universe-region-tabs button").first().click();
  await expect(scene).toHaveAttribute("data-level", "galaxy");
  await expect(page.locator('.universe-node-label[data-knowledge="recorded"]')).toHaveCount(1);
  await expect(page.locator('.universe-node-label[data-knowledge="empty"]')).toHaveCount(1);
  await page.locator(".graph-accessible-list summary").click();
  await page
    .locator(".graph-accessible-list")
    .getByRole("button", { name: "待探索主题", exact: true })
    .click();
  await expect(scene).toHaveAttribute("data-level", "planet");
  await expect(page.locator(".atlas-document-status")).toHaveText("待记录知识");
  await page.getByRole("button", { name: "返回星系", exact: true }).click();
  await expect(scene).toHaveAttribute("data-level", "galaxy");
  await page.getByRole("button", { name: "返回宇宙", exact: true }).click();
  await expect(scene).toHaveAttribute("data-level", "universe");
  memory.graph.nodes[1].has_knowledge = true;
  await page.getByRole("button", { name: "刷新关系", exact: true }).click();
  await expect(page.locator('.universe-node-label[data-knowledge="recorded"]')).toHaveCount(2);
});

test("三维探索手机界面与英文外观库可用且不写入记忆", async ({ page }) => {
  const notes = await mockNotes(page);
  const memory = await mockMemory(page);
  await page.setViewportSize({ width: 360, height: 850 });
  await page.goto("/knowledge/?view=graph&mode=explore");
  await expect(page.locator(".universe-scene")).toHaveAttribute("data-renderer", "webgl", {
    timeout: 20000,
  });
  await page.getByRole("button", { name: /浏览外观库/ }).click();
  await expect(page.getByRole("dialog", { name: "天体外观库" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.keyboard.press("Escape");
  await page.locator(".language-trigger").click();
  await page.getByRole("menuitem", { name: "English", exact: true }).click();
  await expect(page.getByRole("button", { name: "3D universe", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Browse appearances/ }).click();
  const dialog = page.getByRole("dialog", { name: "Celestial library" });
  await expect(dialog).not.toContainText(/[\u3400-\u9fff]/);
  expect(notes.posts).toBe(0);
  expect(notes.patches).toEqual([]);
  expect(memory.actions).toEqual([]);
});
