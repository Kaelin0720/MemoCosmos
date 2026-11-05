import type { MemoryGraph } from "./memory-types";
import type { CelestialKind } from "./celestial-materials";
import { graphNeighbors } from "./graph-physics";

export function seedFor(id: string) {
  let seed = 2166136261;
  for (const char of id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
}
export type UniverseBody = {
  id: string;
  title: string;
  kind: CelestialKind;
  region: string;
  anchor: string | null;
  radius: number;
  orbit: number;
  phase: number;
  speed: number;
  tilt: number;
  seed: number;
  position: [number, number, number];
  hasKnowledge: boolean;
};
export function universeLayout(graph: MemoryGraph) {
  const neighbors = graphNeighbors(graph);
  const groups = new Map<string, typeof graph.nodes>();
  for (const node of graph.nodes) {
    const key = node.region_id ?? node.tags[0]?.id ?? node.folder.split("/")[0] ?? "memory";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(node);
  }
  const regions: { id: string; label: string; root: string; extent: number }[] = [];
  const bodies: UniverseBody[] = [];
  for (const [id, members] of groups) {
    const weight = (node: MemoryGraph["nodes"][number]) =>
      node.weight ?? 1 + neighbors.get(node.id)!.size;
    const sorted = [...members].sort(
      (a, b) =>
        Number(b.kind === "star") - Number(a.kind === "star") ||
        weight(b) - weight(a) ||
        a.id.localeCompare(b.id),
    );
    const root = sorted[0];
    const memberIds = new Set(members.map((node) => node.id));
    const tree = new Map<string, { parent: string | null; depth: number }>([
      [root.id, { parent: null, depth: 0 }],
    ]);
    const queue = [root.id];
    for (let i = 0; i < queue.length; i++)
      for (const next of neighbors.get(queue[i]) ?? []) {
        if (memberIds.has(next) && !tree.has(next)) {
          tree.set(next, { parent: queue[i], depth: tree.get(queue[i])!.depth + 1 });
          queue.push(next);
        }
      }
    const ordered = [...members].sort(
      (a, b) =>
        (tree.get(a.id)?.depth ?? 1) - (tree.get(b.id)?.depth ?? 1) || a.id.localeCompare(b.id),
    );
    const siblingCount = new Map<string, number>();
    let extent = 160;
    for (const node of ordered) {
      const branch = tree.get(node.id);
      const kind: CelestialKind =
        node.id === root.id
          ? "star"
          : (node.kind ?? ((branch?.depth ?? 1) >= 2 ? "moon" : "planet"));
      const anchor = node.id === root.id ? null : (branch?.parent ?? root.id);
      const index = siblingCount.get(anchor ?? "root") ?? 0;
      siblingCount.set(anchor ?? "root", index + 1);
      const seed = seedFor(node.id),
        radius =
          kind === "star"
            ? 25 + Math.log2(weight(node) + 1) * 8
            : kind === "planet"
              ? 9 + Math.sqrt(weight(node)) * 3.4
              : 3.8 + Math.sqrt(weight(node)) * 0.6;
      const parent = bodies.find((body) => body.id === anchor);
      const orbit =
        kind === "star"
          ? 0
          : kind === "moon"
            ? (parent?.radius ?? 20) + 22 + index * 15
            : 155 + Math.sqrt(index) * 110;
      extent = Math.max(extent, orbit + (kind === "moon" ? (parent?.orbit ?? 0) : 0) + radius * 3);
      bodies.push({
        id: node.id,
        title: node.title,
        kind,
        region: id,
        anchor,
        radius,
        orbit,
        phase: (seed % 6283) / 1000,
        speed:
          kind === "moon" ? 0.035 + index * 0.007 : 0.016 / Math.pow(Math.max(1, orbit / 155), 1.2),
        tilt: 0.08 + (seed % 30) / 100,
        seed,
        position: [0, 0, 0],
        hasKnowledge: node.has_knowledge === true,
      });
    }
    const defined = graph.regions?.find((region) => region.id === id);
    regions.push({
      id,
      label: defined?.label ?? root.tags[0]?.name ?? root.folder.split("/")[0] ?? root.title,
      root: root.id,
      extent,
    });
  }
  // Regions organize the view; relationships form a free network, not a solar system.
  for (const region of regions) {
    const members = bodies.filter((body) => body.region === region.id);
    const positions = members.map((body, i) => {
      const a = i * 2.399963 + (body.seed % 6283) / 1000;
      const r = 85 + Math.sqrt(i + 1) * 28;
      return [Math.cos(a) * r, Math.sin(a * 1.7) * r * 0.7, Math.sin(a) * r * 0.7];
    });
    const index = new Map(members.map((body, i) => [body.id, i]));
    for (let step = 0; step < 160; step++) {
      const forces = positions.map((p) => p.map((v) => -v * 0.0009));
      for (let i = 0; i < members.length; i++)
        for (let j = i + 1; j < members.length; j++) {
          const delta = positions[i].map((v, axis) => v - positions[j][axis]);
          const distance = Math.max(1, Math.hypot(...delta));
          const strength = 1400 / (distance * distance + 60) + Math.max(0, 48 - distance) * 0.08;
          delta.forEach((v, axis) => {
            forces[i][axis] += (v / distance) * strength;
            forces[j][axis] -= (v / distance) * strength;
          });
        }
      for (const edge of graph.edges) {
        const i = index.get(edge.source),
          j = index.get(edge.target);
        if (i === undefined || j === undefined) continue;
        const delta = positions[j].map((v, axis) => v - positions[i][axis]);
        const distance = Math.max(1, Math.hypot(...delta));
        delta.forEach((v, axis) => {
          const f = (v / distance) * (distance - 100) * 0.006;
          forces[i][axis] += f;
          forces[j][axis] -= f;
        });
      }
      positions.forEach((p, i) =>
        p.forEach((_, axis) => {
          p[axis] += forces[i][axis];
        }),
      );
    }
    const center = [0, 1, 2].map(
      (axis) => positions.reduce((sum, p) => sum + p[axis], 0) / members.length,
    );
    members.forEach((body, i) => {
      body.position = positions[i].map((v, axis) => v - center[axis]) as [number, number, number];
      body.anchor = null;
      body.orbit = 0;
      body.radius = 6 + Math.pow(neighbors.get(body.id)!.size + 1, 0.72) * 2.8;
    });
    region.extent = Math.max(
      180,
      ...members.map((body) => Math.hypot(...body.position) + body.radius * 2),
    );
  }
  return { bodies, regions, neighbors };
}
