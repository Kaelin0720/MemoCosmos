import { test, expect } from "@playwright/test";
import { createGraphPhysics } from "../src/lib/graph-physics";
import type { MemoryGraph } from "../src/lib/memory-types";
import { constellationPreview } from "../src/lib/constellation-preview";

function fixture(): MemoryGraph {
  const nodes = ["a", "b", "c", "d"].map((id) => ({
    id,
    title: `主题 ${id}`,
    folder: "",
    tags: [],
  }));
  const edges = [
    ["a", "b"],
    ["a", "b"],
    ["a", "c"],
    ["b", "c"],
    ["a", "a"],
  ].map(([source, target], i) => ({
    id: `edge-${i}`,
    source,
    target,
    relation: "关联",
    evidence: "原始证据",
    source_message_id: null,
    created_at: "2026-10-13T00:00:00Z",
  }));
  return { nodes, edges };
}
function freeze(value: object) {
  Object.values(value).forEach((item) => {
    if (item && typeof item === "object") freeze(item);
  });
  return Object.freeze(value);
}

test("D3 使用克隆数据，重复关系和自连接不增加节点权重", () => {
  const graph = fixture(),
    original = JSON.stringify(graph);
  freeze(graph);
  const physics = createGraphPhysics(graph, 800, 440);
  expect(physics.nodes.map(({ weight }) => weight)).toEqual([2, 2, 2, 0]);
  expect(physics.nodes[0].radius).toBeGreaterThan(physics.nodes[3].radius);
  expect(typeof physics.links[0].source).toBe("object");
  physics.simulation.tick(400);
  expect(JSON.stringify(graph)).toBe(original);
  expect(graph.edges[0].source).toBe("a");
  physics.simulation.stop();
});

test("冷却后每个节点仍独立漂移，拖拽固定点之外的节点保持模拟和碰撞斥力", () => {
  const physics = createGraphPhysics(fixture(), 800, 440);
  physics.simulation.tick(800);
  const before = physics.nodes.map(({ x, y }) => ({ x, y }));
  physics.simulation.tick(100);
  expect(physics.simulation.alpha()).toBeGreaterThan(physics.simulation.alphaMin());
  const after = physics.nodes;
  expect(
    after.every(
      (node, index) => Math.hypot(node.x - before[index].x, node.y - before[index].y) > 0.01,
    ),
  ).toBe(true);
  const oldDistance = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y);
  const newDistance = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
  expect(Math.abs(oldDistance - newDistance)).toBeGreaterThan(0.01);
  const [fixed, free] = after;
  fixed.fx = fixed.x = 400;
  fixed.fy = fixed.y = 220;
  free.x = 400;
  free.y = 220;
  free.vx = free.vy = 0;
  physics.simulation.tick(80);
  expect([fixed.x, fixed.y]).toEqual([400, 220]);
  expect(Math.hypot(free.x - fixed.x, free.y - fixed.y)).toBeGreaterThan(
    free.radius + fixed.radius,
  );
  fixed.fx = fixed.fy = null;
  physics.simulation.tick(80);
  expect([fixed.x, fixed.y]).not.toEqual([400, 220]);
  physics.simulation.stop();
});

test("同一拓扑重建延续坐标和速度，新增节点在原邻居附近加入并重新升温", () => {
  const graph = fixture();
  const first = createGraphPhysics(graph, 800, 440);
  first.simulation.tick(600);
  const state = first.snapshot();
  const second = createGraphPhysics(
    { ...graph, nodes: graph.nodes.map((node) => ({ ...node, title: `English ${node.id}` })) },
    800,
    440,
    state,
  );
  expect(second.snapshot().points).toEqual(state.points);
  expect(second.simulation.alpha()).toBe(state.alpha);
  graph.nodes.push({ id: "new", title: "新主题", folder: "", tags: [] });
  graph.edges.push({ ...graph.edges[0], id: "new-edge", source: "a", target: "new" });
  const third = createGraphPhysics(graph, 800, 440, state);
  expect(third.snapshot().points.get("a")).toEqual(state.points.get("a"));
  const newNode = third.nodes.find((node) => node.id === "new")!,
    neighbor = third.nodes[0];
  expect(Math.hypot(newNode.x - neighbor.x, newNode.y - neighbor.y)).toBeCloseTo(24);
  expect(third.simulation.alpha()).toBeGreaterThan(state.alpha);
  third.resize(300, 420);
  third.simulation.tick(150);
  expect(
    third.nodes.every((node) => [node.x, node.y, node.vx, node.vy].every(Number.isFinite)),
  ).toBe(true);
  [first, second, third].forEach((physics) => physics.simulation.stop());
});

test("窄画布运行两千帧后边缘星点仍缓慢运动，标签留在画布范围内", () => {
  const physics = createGraphPhysics(constellationPreview("zh-CN").graph, 338, 420);
  physics.simulation.tick(2000);
  const before = physics.nodes.map(({ x, y }) => ({ x, y }));
  physics.simulation.tick(120);
  expect(
    physics.nodes.every(
      (node, index) => Math.hypot(node.x - before[index].x, node.y - before[index].y) > 0.001,
    ),
  ).toBe(true);
  physics.nodes.forEach((node) => {
    expect(node.x).toBeGreaterThan(24);
    expect(node.x).toBeLessThan(338 - 24);
    expect(node.y + node.radius + 28).toBeLessThan(420);
  });
  physics.simulation.stop();
});
