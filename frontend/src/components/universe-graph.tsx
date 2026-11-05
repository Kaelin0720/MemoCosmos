"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { t, useLocale } from "@/lib/i18n";
import type { MemoryGraph } from "@/lib/memory-types";
import type { AtlasRenderer as UniverseRenderer, AtlasNavigation } from "@/lib/atlas-renderer";
import { ArrowLeft } from "lucide-react";
import type { CelestialKind, CelestialStyle } from "@/lib/celestial-materials";
import { ForceGraph, type ForceGraphHandle } from "./force-graph";

export type UniverseHandle = ForceGraphHandle & {
  thumbnail: (kind: CelestialKind, surface: string) => HTMLCanvasElement | null;
  enterRegion: (id: string) => void;
};
export function UniverseGraph({
  graph,
  selected,
  paused,
  styles,
  path,
  onSelect,
  onRunning,
  onClear,
  onRegionChange,
  ref,
}: {
  graph: MemoryGraph;
  selected: string | null;
  paused: boolean;
  styles: Record<string, CelestialStyle>;
  path: string[];
  onSelect: (id: string) => void;
  onRunning: (running: boolean) => void;
  onClear: () => void;
  onRegionChange: (id: string | null) => void;
  ref?: Ref<UniverseHandle>;
}) {
  const locale = useLocale();
  const canvas = useRef<HTMLCanvasElement>(null),
    labels = useRef<HTMLDivElement>(null);
  const runtime = useRef<UniverseRenderer | null>(null),
    fallback = useRef<ForceGraphHandle>(null);
  const snapshot = useRef<ReturnType<UniverseRenderer["snapshot"]> | null>(null);
  const actions = useRef({ onSelect, onRunning, onClear, onRegionChange }),
    state = useRef({ paused, selected, styles, path });
  const [failed, setFailed] = useState(false),
    [ready, setReady] = useState(false);
  const [navigation, setNavigation] = useState<AtlasNavigation>({
    level: "universe",
    region: null,
    label: "",
  });
  const regionNodes = graph.nodes.filter(
    (node) =>
      navigation.region === null ||
      (node.region_id ?? node.tags[0]?.id ?? node.folder.split("/")[0] ?? "memory") ===
        navigation.region,
  );
  const recorded = regionNodes.filter((node) => node.has_knowledge === true).length;
  useEffect(() => {
    actions.current = { onSelect, onRunning, onClear, onRegionChange };
  }, [onSelect, onRunning, onClear, onRegionChange]);
  useEffect(() => {
    state.current = { paused, selected, styles, path };
    const instance = runtime.current;
    if (!instance) return;
    instance.setPaused(paused);
    instance.setSelected(selected);
    instance.setPath(path);
    for (const [id, style] of Object.entries(styles)) instance.setStyle(id, style);
  }, [paused, selected, styles, path]);
  useImperativeHandle(
    ref,
    () => ({
      zoomBy(factor) {
        if (runtime.current) runtime.current.zoomBy(factor);
        else fallback.current?.zoomBy(factor);
      },
      reset() {
        if (runtime.current) runtime.current.reset();
        else fallback.current?.reset();
      },
      thumbnail(kind, surface) {
        return runtime.current?.thumbnail(kind, surface) ?? null;
      },
      enterRegion(id) {
        runtime.current?.enterRegion(id);
      },
    }),
    [],
  );
  useEffect(() => {
    let disposed = false;
    const element = canvas.current,
      layer = labels.current;
    if (!element || !layer || failed) return;
    void import("@/lib/atlas-renderer")
      .then(({ AtlasRenderer: UniverseRenderer }) => {
        if (disposed) return;
        try {
          const instance = new UniverseRenderer(element, layer, graph, {
            select: (id) => actions.current.onSelect(id),
            clear: () => actions.current.onClear(),
            navigation: (value) => {
              setNavigation(value);
              actions.current.onRegionChange(value.region);
            },
            running: (value) => actions.current.onRunning(value),
            failed: () => {
              if (!disposed) {
                runtime.current?.dispose();
                runtime.current = null;
                setFailed(true);
              }
            },
            label: (kind) =>
              t(kind === "star" ? "核心主题" : kind === "planet" ? "关联知识" : "细节笔记"),
          });
          runtime.current = instance;
          if (snapshot.current) instance.restore(snapshot.current);
          instance.setPaused(state.current.paused);
          instance.setSelected(state.current.selected);
          instance.setPath(state.current.path);
          for (const [id, style] of Object.entries(state.current.styles))
            instance.setStyle(id, style);
          setReady(true);
        } catch {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      if (runtime.current) snapshot.current = runtime.current.snapshot();
      runtime.current?.dispose();
      runtime.current = null;
    };
  }, [graph, locale, failed]);
  if (failed)
    return (
      <div className="universe-fallback">
        <p role="status">{t("当前设备暂不支持三维渲染，已切换二维图谱")}</p>
        <ForceGraph
          ref={fallback}
          graph={graph}
          selected={selected}
          paused={paused}
          edgeId={null}
          onSelect={onSelect}
          onEdge={() => {}}
          onRunning={onRunning}
        />
      </div>
    );
  return (
    <div
      className="universe-scene"
      data-renderer={ready ? "webgl" : "loading"}
      data-level={navigation.level}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
          return;
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        runtime.current?.rotate(
          event.key === "ArrowLeft" ? -0.12 : event.key === "ArrowRight" ? 0.12 : 0,
          event.key === "ArrowUp" ? -0.1 : event.key === "ArrowDown" ? 0.1 : 0,
        );
      }}
    >
      <canvas
        ref={canvas}
        role="img"
        aria-label={t("三维记忆宇宙，拖拽旋转，滚轮缩放，点击天体查看文档")}
      />
      <div ref={labels} className="universe-labels" aria-label={t("知识天体")} />
      {ready && (
        <nav className="atlas-breadcrumb" aria-label={t("宇宙层级")}>
          {navigation.level !== "universe" && (
            <button type="button" onClick={() => runtime.current?.back()}>
              <ArrowLeft size={14} />
              {navigation.level === "planet" ? t("返回星系") : t("返回宇宙")}
            </button>
          )}
          <span>{navigation.level === "universe" ? t("记忆宇宙") : navigation.label}</span>
        </nav>
      )}
      {!ready && (
        <p className="universe-loading" role="status">
          {t("正在展开你的记忆宇宙…")}
        </p>
      )}
      <div className="universe-legend" aria-label={t("知识记录状态")}>
        <span className="atlas-recorded">
          {t("已记录")} {recorded}
        </span>
        <span className="atlas-empty">
          {t("待记录")} {regionNodes.length - recorded}
        </span>
      </div>
    </div>
  );
}
