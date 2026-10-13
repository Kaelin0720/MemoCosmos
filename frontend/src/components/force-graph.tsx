"use client";
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { select } from "d3-selection";
import { drag } from "d3-drag";
import { zoom, zoomIdentity, zoomTransform, type ZoomBehavior } from "d3-zoom";
import { t, useLocale } from "@/lib/i18n";
import type { MemoryGraph } from "@/lib/memory-types";
import {
  createGraphPhysics,
  graphLabel,
  type GraphPoint,
  type GraphLink,
  type GraphPhysics,
} from "@/lib/graph-physics";

export type ForceGraphHandle = { zoomBy: (factor: number) => void; reset: () => void };
type Props = {
  graph: MemoryGraph;
  paused: boolean;
  selected: string | null;
  edgeId: string | null;
  onSelect: (id: string) => void;
  onEdge: (id: string) => void;
  onRunning: (running: boolean) => void;
  ref?: Ref<ForceGraphHandle>;
};
export function ForceGraph({
  graph,
  paused,
  selected,
  edgeId,
  onSelect,
  onEdge,
  onRunning,
  ref,
}: Props) {
  const locale = useLocale();
  const paintId = `graph-${useId().replace(/:/g, "")}`;
  const svg = useRef<SVGSVGElement>(null),
    network = useRef<SVGGElement>(null);
  const actions = useRef({ onSelect, onEdge, onRunning });
  const gate = useRef({ paused, inView: true });
  const emphasis = useRef({ selected, edgeId });
  const saved = useRef<ReturnType<GraphPhysics["snapshot"]>>(undefined);
  const runtime = useRef<{
    physics: GraphPhysics;
    zoom: ZoomBehavior<SVGSVGElement, unknown>;
    draw: () => void;
    highlight: () => void;
    running: () => void;
  } | null>(null);
  useEffect(() => {
    actions.current = { onSelect, onEdge, onRunning };
  }, [onSelect, onEdge, onRunning]);
  useEffect(() => {
    emphasis.current = { selected, edgeId };
    runtime.current?.highlight();
  }, [selected, edgeId]);
  useEffect(() => {
    gate.current.paused = paused;
    runtime.current?.running();
  }, [paused]);
  useImperativeHandle(
    ref,
    () => ({
      zoomBy(factor) {
        if (svg.current && runtime.current)
          select(svg.current).call(runtime.current.zoom.scaleBy, factor);
      },
      reset() {
        const current = runtime.current;
        if (!current || !svg.current) return;
        current.physics.reset();
        current.draw();
        select(svg.current).call(current.zoom.transform, zoomIdentity);
        current.running();
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    const element = svg.current,
      layer = network.current;
    if (!element || !layer) return;
    let width = Math.max(1, element.clientWidth),
      height = Math.max(1, element.clientHeight);
    element.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const physics = createGraphPhysics(graph, width, height, saved.current);
    let hovered: string | null = null,
      focused: string | null = null;
    // Replace the old single-line layer when this component is hot-reloaded.
    select(layer).selectAll("line.graph-edge").remove();
    const lines = select(layer)
      .selectAll<SVGGElement, GraphLink>("g.graph-edge")
      .data(physics.links, (link) => link.id)
      .join((enter) => {
        const group = enter.append("g");
        group
          .append("defs")
          .append("linearGradient")
          .attr("gradientUnits", "userSpaceOnUse")
          .attr("href", `#${paintId}-connection`)
          .attr("x1", 0)
          .attr("y1", 0)
          .attr("y2", 0);
        group.append("line").attr("class", "graph-edge-hit");
        group
          .append("line")
          .attr("class", "graph-edge-glow")
          .attr("aria-hidden", "true")
          .attr("pointer-events", "none");
        group
          .append("line")
          .attr("class", "graph-edge-core")
          .attr("aria-hidden", "true")
          .attr("pointer-events", "none");
        group.selectAll("line").attr("vector-effect", "non-scaling-stroke");
        return group;
      })
      .attr("class", "graph-edge")
      .attr("data-source", (link) => (link.source as GraphPoint).id)
      .attr("data-target", (link) => (link.target as GraphPoint).id)
      .lower()
      .on("click.graph", (event, link) => {
        event.stopPropagation();
        actions.current.onEdge(link.id);
      });
    lines.select("linearGradient").attr("id", (_, index) => `${paintId}-edge-${index}`);
    lines.select(".graph-edge-glow").attr("stroke", (_, index) => `url(#${paintId}-edge-${index})`);
    const nodes = select(layer)
      .selectAll<SVGGElement, GraphPoint>(".graph-node")
      .data(physics.nodes, (node) => node.id)
      .join((enter) => {
        const group = enter.append("g").attr("class", "graph-node");
        group.append("circle").attr("class", "graph-hit");
        group.append("circle").attr("class", "graph-core");
        group.append("text").attr("text-anchor", "middle");
        group.append("title");
        return group;
      })
      .attr("role", "button")
      .attr("tabindex", 0)
      .attr("data-node-id", (node) => node.id)
      .attr("data-weight", (node) => node.weight)
      .attr("aria-label", (node) => t("选择节点 {0}", [node.title]));
    const aura = nodes
      .selectAll<SVGGElement, GraphPoint>(".graph-aura")
      .data((node) => [node])
      .join((enter) => {
        const group = enter
          .append("g")
          .attr("class", "graph-aura")
          .attr("aria-hidden", "true")
          .attr("pointer-events", "none");
        group.append("circle").attr("class", "graph-halo");
        group.append("circle").attr("class", "graph-corona");
        group.append("path").attr("class", "graph-rays");
        return group;
      })
      .lower();
    aura
      .select(".graph-halo")
      .attr("r", (node) => node.radius * 3 + 6)
      .attr("fill", `url(#${paintId}-halo)`);
    aura
      .select(".graph-corona")
      .attr("r", (node) => node.radius * 1.6)
      .attr("fill", `url(#${paintId}-corona)`);
    aura
      .select(".graph-rays")
      .attr("fill", `url(#${paintId}-corona)`)
      .attr("d", (node) => {
        const length = node.radius * 2,
          thin = 0.4;
        return `M0 ${-length} L${thin} ${-thin} L${length * 0.78} 0 L${thin} ${thin} L0 ${length} L${-thin} ${thin} L${-length * 0.78} 0 L${-thin} ${-thin}Z`;
      });
    nodes.select(".graph-core").attr("r", (node) => node.radius * 0.58);
    nodes.select(".graph-hit").attr("r", (node) => Math.max(16, node.radius + 7));
    nodes
      .select("text")
      .attr("y", (node) => node.radius + 16)
      .text((node) => graphLabel(node.title, width));
    nodes
      .select("title")
      .text((node) => `${node.title}\n${t("星点大小表示关联数量")} · ${node.weight}`);
    function highlight() {
      const active = hovered ?? focused ?? emphasis.current.selected;
      const neighbors = active ? physics.neighbors.get(active) : undefined;
      nodes
        .classed("selected", (node) => node.id === emphasis.current.selected)
        .classed("highlighted", (node) => node.id === active || Boolean(neighbors?.has(node.id)))
        .classed("dimmed", (node) =>
          Boolean(active && node.id !== active && !neighbors?.has(node.id)),
        );
      lines
        .classed("selected", (link) => link.id === emphasis.current.edgeId)
        .classed(
          "highlighted",
          (link) =>
            (link.source as GraphPoint).id === active ||
            (link.target as GraphPoint).id === active ||
            link.id === emphasis.current.edgeId,
        )
        .classed("dimmed", (link) =>
          Boolean(
            active &&
            (link.source as GraphPoint).id !== active &&
            (link.target as GraphPoint).id !== active &&
            link.id !== emphasis.current.edgeId,
          ),
        );
    }
    function draw() {
      nodes.attr("transform", (node) => `translate(${node.x},${node.y})`);
      lines.each(function (link) {
        const from = link.source as GraphPoint,
          to = link.target as GraphPoint;
        const dx = to.x - from.x,
          dy = to.y - from.y,
          length = Math.hypot(dx, dy);
        const group = select(this);
        group.attr(
          "transform",
          `translate(${from.x},${from.y}) rotate(${(Math.atan2(dy, dx) * 180) / Math.PI})`,
        );
        group.selectAll("line").attr("x2", length);
        group.select("linearGradient").attr("x2", Math.max(0.001, length));
      });
    }
    function running() {
      const active = !gate.current.paused && gate.current.inView && Boolean(physics.nodes.length);
      if (active) physics.simulation.restart();
      else physics.simulation.stop();
      element!.dataset.motionState = active ? "moving" : "paused";
      actions.current.onRunning(active);
    }
    const zoomer = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.35, 4])
      .touchable(() => true)
      .extent(() => [
        [0, 0],
        [width, height],
      ])
      .filter(
        (event) =>
          (!event.button || event.type === "wheel") &&
          (event.type === "wheel" ||
            !(event.target instanceof Element && event.target.closest(".graph-node"))),
      )
      .on("zoom.graph", (event) => {
        select(layer).attr("transform", event.transform.toString());
        // Labels keep their screen size when zooming; the viewBox uses real pixels.
        nodes.select("text").style("font-size", `${12 / event.transform.k}px`);
      });
    select(element).call(zoomer).on("dblclick.zoom", null);
    const transform = zoomTransform(element);
    select(layer).attr("transform", transform.toString());
    nodes.select("text").style("font-size", `${12 / transform.k}px`);
    const dragging = drag<SVGGElement, GraphPoint>()
      .container(() => layer)
      .clickDistance(3)
      .on("start.graph", function (event, node) {
        node.fx = node.x;
        node.fy = node.y;
        node.vx = node.vy = 0;
        select(this).classed("dragging", true);
        actions.current.onSelect(node.id);
        if (!gate.current.paused && gate.current.inView)
          physics.simulation.alpha(Math.max(0.15, physics.simulation.alpha())).restart();
        event.sourceEvent.stopPropagation();
      })
      .on("drag.graph", (event, node) => {
        node.fx = node.x = event.x;
        node.fy = node.y = event.y;
        draw();
      })
      .on("end.graph", function (_, node) {
        node.fx = node.fy = null;
        node.vx = node.vy = 0;
        select(this).classed("dragging", false);
      });
    nodes
      .call(dragging)
      .on("mouseenter.graph", (_, node) => {
        hovered = node.id;
        highlight();
      })
      .on("mouseleave.graph", () => {
        hovered = null;
        highlight();
      })
      .on("focus.graph", (_, node) => {
        focused = node.id;
        highlight();
      })
      .on("blur.graph", (_, node) => {
        focused = null;
        node.fx = node.fy = null;
        highlight();
      })
      .on("click.graph", (_, node) => actions.current.onSelect(node.id))
      .on("keydown.graph", (event, node) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          actions.current.onSelect(node.id);
        }
        if (event.key.startsWith("Arrow")) {
          event.preventDefault();
          const k = zoomTransform(element).k;
          node.fx = node.x +=
            (event.key === "ArrowRight" ? 10 : event.key === "ArrowLeft" ? -10 : 0) / k;
          node.fy = node.y +=
            (event.key === "ArrowDown" ? 10 : event.key === "ArrowUp" ? -10 : 0) / k;
          node.vx = node.vy = 0;
          draw();
        }
      })
      .on("keyup.graph", (event, node) => {
        if (event.key.startsWith("Arrow")) node.fx = node.fy = null;
      });
    physics.simulation.on("tick.graph", draw);
    runtime.current = { physics, zoom: zoomer, draw, highlight, running };
    const observer = new ResizeObserver(() => {
      const nextWidth = element.clientWidth,
        nextHeight = element.clientHeight;
      if (!nextWidth || !nextHeight || (nextWidth === width && nextHeight === height)) return;
      width = nextWidth;
      height = nextHeight;
      element.setAttribute("viewBox", `0 0 ${width} ${height}`);
      physics.resize(width, height);
      nodes.select("text").text((node) => graphLabel(node.title, width));
      draw();
    });
    observer.observe(element);
    const visibility = new IntersectionObserver(([entry]) => {
      gate.current.inView = entry.isIntersecting;
      running();
    });
    visibility.observe(element);
    draw();
    highlight();
    running();
    return () => {
      observer.disconnect();
      visibility.disconnect();
      physics.simulation.stop().on("tick.graph", null);
      saved.current = physics.snapshot();
      nodes.on(".drag", null).on(".graph", null);
      lines.on(".graph", null);
      select(element).on(".zoom", null);
      select(window).on(".drag", null);
      runtime.current = null;
    };
  }, [graph, locale, paintId]);
  return (
    <svg ref={svg} className="force-graph" aria-label={t("关系画布，可拖拽节点和空白处")}>
      <defs aria-hidden="true">
        <radialGradient id={`${paintId}-halo`}>
          <stop stopColor="#d7efff" stopOpacity=".6" />
          <stop offset=".18" stopColor="#a6d9ff" stopOpacity=".36" />
          <stop offset=".44" stopColor="#72acff" stopOpacity=".13" />
          <stop offset="1" stopColor="#5285dd" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${paintId}-corona`}>
          <stop stopColor="#ffffff" stopOpacity=".95" />
          <stop offset=".28" stopColor="#e6f7ff" stopOpacity=".65" />
          <stop offset=".55" stopColor="#acd6ff" stopOpacity=".24" />
          <stop offset="1" stopColor="#7cafff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${paintId}-connection`}>
          <stop stopColor="#ddf5ff" stopOpacity=".7" />
          <stop offset=".12" stopColor="#a8d6ff" stopOpacity=".35" />
          <stop offset=".5" stopColor="#79adf6" stopOpacity=".06" />
          <stop offset=".88" stopColor="#a8d6ff" stopOpacity=".35" />
          <stop offset="1" stopColor="#ddf5ff" stopOpacity=".7" />
        </linearGradient>
      </defs>
      <g className="graph-starfield" aria-hidden="true" pointerEvents="none">
        {Array.from({ length: 90 }, (_, index) => (
          <circle
            key={index}
            cx={`${(index * 37.5 + 4) % 100}%`}
            cy={`${(index * 61.8 + 7) % 100}%`}
            r={index % 9 === 0 ? 1 : 0.55}
            opacity={0.13 + (index % 5) * 0.045}
          />
        ))}
      </g>
      <g ref={network} className="graph-network" />
    </svg>
  );
}
