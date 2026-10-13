import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import type { MemoryGraph } from "./memory-types";

export type GraphPoint = SimulationNodeDatum & {
  id: string;
  title: string;
  weight: number;
  radius: number;
  phase: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};
export type GraphLink = SimulationLinkDatum<GraphPoint> & { id: string };

export function graphNeighbors(graph: MemoryGraph) {
  const neighbors = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of graph.edges) {
    if (edge.source === edge.target || !neighbors.has(edge.source) || !neighbors.has(edge.target))
      continue;
    neighbors.get(edge.source)!.add(edge.target);
    neighbors.get(edge.target)!.add(edge.source);
  }
  return neighbors;
}
function phase(id: string) {
  let value = 2166136261;
  for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  // Avalanche similar IDs so adjacent numeric suffixes do not drift in unison.
  value = Math.imul(value ^ (value >>> 16), 2246822507);
  value = Math.imul(value ^ (value >>> 13), 3266489909);
  value ^= value >>> 16;
  return ((value >>> 0) / 4294967296) * Math.PI * 2;
}
export function graphLabel(title: string, width: number) {
  const chars = Array.from(title),
    limit = width < 500 ? 14 : 26;
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : title;
}

type PhysicsState = {
  width: number;
  height: number;
  time: number;
  alpha: number;
  topology: string;
  points: Map<string, Pick<GraphPoint, "x" | "y" | "vx" | "vy">>;
};
export function createGraphPhysics(
  graph: MemoryGraph,
  initialWidth: number,
  initialHeight: number,
  previous?: PhysicsState,
) {
  let width = initialWidth,
    height = initialHeight,
    time = previous?.time ?? 0;
  const neighbors = graphNeighbors(graph);
  const topology = JSON.stringify([
    graph.nodes.map((node) => node.id).sort(),
    graph.edges.map((edge) => [edge.id, edge.source, edge.target]).sort(),
  ]);
  // D3 mutates nodes and link endpoints. Only these rendering copies enter D3.
  const nodes: GraphPoint[] = graph.nodes.map((node) => {
    const weight = neighbors.get(node.id)!.size;
    return {
      id: node.id,
      title: node.title,
      weight,
      radius: 3.5 + Math.sqrt(weight) * 2.1,
      phase: phase(node.id),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    };
  });
  const links: GraphLink[] = graph.edges
    .filter((link) => neighbors.has(link.source) && neighbors.has(link.target))
    .map((link) => ({ id: link.id, source: link.source, target: link.target }));
  const drift: Force<GraphPoint, GraphLink> = () => {
    time += 1 / 60;
    for (const node of nodes) {
      if (node.fx != null || node.fy != null) continue;
      // Independent phases and frequencies change relative positions, rather
      // than rotating/translating the graph as a rigid group.
      node.vx += 0.025 * Math.sin(time * (0.22 + (node.phase % 0.12)) + node.phase);
      node.vy += 0.025 * Math.cos(time * (0.19 + (node.phase % 0.09)) + node.phase * 1.7);
    }
  };
  const boundary: Force<GraphPoint, GraphLink> = () => {
    for (const node of nodes) {
      if (node.fx != null || node.fy != null) continue;
      const labelWidth = Array.from(graphLabel(node.title, width)).reduce(
        (sum, char) => sum + (char.charCodeAt(0) > 255 ? 12 : 6.5),
        0,
      );
      const padX = Math.min(width / 3, Math.max(32, labelWidth / 2 + 24));
      const padY = node.radius + 42;
      // A soft boundary leaves room for labels without pinning stars at corners.
      node.vx += (Math.max(0, padX - node.x) - Math.max(0, node.x - width + padX)) * 0.35;
      node.vy += (Math.max(0, padY - node.y) - Math.max(0, node.y - height + padY)) * 0.35;
    }
  };
  const spacing = () =>
    Math.min(145, Math.max(62, Math.sqrt((width * height) / Math.max(1, nodes.length)) * 0.72));
  const linkForce = forceLink<GraphPoint, GraphLink>(links)
    .id((node) => node.id)
    .distance(spacing())
    .strength(0.22);
  const charge = forceManyBody<GraphPoint>()
    .strength(() => -(spacing() ** 2) * 0.035)
    .distanceMin(18);
  const x = forceX<GraphPoint>(width / 2).strength(0.028),
    y = forceY<GraphPoint>(height / 2).strength(0.028);
  const collisionRadius = (node: GraphPoint) => {
    const labelWidth = Array.from(graphLabel(node.title, width)).length * 9;
    return Math.max(node.radius + 10, Math.min(39, labelWidth * 0.3 + 12));
  };
  const collision = forceCollide<GraphPoint>(collisionRadius).strength(0.85).iterations(2);
  const simulation = forceSimulation<GraphPoint>(nodes)
    .stop()
    .alpha(0.5)
    .alphaMin(0.001)
    .alphaTarget(0.075)
    .alphaDecay(0.035)
    .velocityDecay(0.32)
    .force("charge", charge)
    .force("links", linkForce)
    .force("collide", collision)
    .force("x", x)
    .force("y", y)
    .force("drift", drift)
    .force("boundary", boundary);
  function reset() {
    time = 0;
    nodes.forEach((node, index) => {
      const angle = index * 2.399963,
        radius = Math.sqrt(index / Math.max(1, nodes.length)) * Math.min(width, height) * 0.32;
      node.x = width / 2 + Math.cos(angle) * radius;
      node.y = height / 2 + Math.sin(angle) * radius;
      node.vx = node.vy = 0;
      node.fx = node.fy = null;
    });
    simulation.alpha(0.5).tick(100);
  }
  function resize(nextWidth: number, nextHeight: number) {
    for (const node of nodes) {
      node.x *= nextWidth / width;
      node.y *= nextHeight / height;
    }
    width = nextWidth;
    height = nextHeight;
    linkForce.distance(spacing());
    charge.strength(() => -(spacing() ** 2) * 0.035);
    collision.radius(collisionRadius);
    x.x(width / 2);
    y.y(height / 2);
    simulation.alpha(0.2).tick(45);
  }
  if (previous && nodes.some((node) => previous.points.has(node.id))) {
    const scaleX = width / previous.width,
      scaleY = height / previous.height;
    for (const node of nodes) {
      const old = previous.points.get(node.id);
      const related = [...neighbors.get(node.id)!].flatMap((id) => {
        const point = previous.points.get(id);
        return point ? [point] : [];
      });
      node.x = old
        ? old.x * scaleX
        : (related.length
            ? ((related.reduce((sum, point) => sum + point.x, 0) / related.length) * width) /
              previous.width
            : width / 2) +
          Math.cos(node.phase) * 24;
      node.y = old
        ? old.y * scaleY
        : (related.length
            ? ((related.reduce((sum, point) => sum + point.y, 0) / related.length) * height) /
              previous.height
            : height / 2) +
          Math.sin(node.phase) * 24;
      node.vx = (old?.vx ?? 0) * scaleX;
      node.vy = (old?.vy ?? 0) * scaleY;
    }
    simulation.alpha(previous.topology === topology ? previous.alpha : 0.35);
  } else reset();
  function snapshot(): PhysicsState {
    return {
      width,
      height,
      time,
      alpha: simulation.alpha(),
      topology,
      points: new Map(nodes.map(({ id, x, y, vx, vy }) => [id, { x, y, vx, vy }])),
    };
  }
  return { nodes, links, neighbors, simulation, resize, reset, snapshot };
}
export type GraphPhysics = ReturnType<typeof createGraphPhysics>;
