"use client";
import { t, uiDate, uiMessage, useLocale } from "@/lib/i18n";
import { ActionButton } from "@/components/motion-system";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { MemoryGraph as Graph } from "@/lib/memory-types";
import { useSpace } from "./space-shell";
import { useMotionEnvironment } from "./ambient-motion";
import { ForceGraph, type ForceGraphHandle } from "./force-graph";
import { UniverseGraph, type UniverseHandle } from "./universe-graph";
import { CelestialPicker } from "./celestial-picker";
import { useUniversePreferences } from "@/lib/universe-preferences";
import { universeLayout } from "@/lib/universe-layout";
import {
  appearancesFor,
  defaultSurface,
  type CelestialKind,
  type CelestialStyle,
} from "@/lib/celestial-materials";
import type { MemoryHit } from "@/lib/memory-types";

import {
  ArrowUpRight,
  Compass,
  Network,
  Orbit,
  Pause,
  Play,
  RotateCcw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Modal } from "./ui";
import { constellationPreview } from "@/lib/constellation-preview";

export type GraphMode = "library" | "explore";
export function MemoryGraph({
  onOpen,
  initialMode = "library",
}: {
  onOpen: (id: string) => void;
  initialMode?: GraphMode;
}) {
  const locale = useLocale();
  const [mode, setMode] = useState<GraphMode>(initialMode);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [canvasRunning, setCanvasRunning] = useState(false);
  const [activeRegion, setActiveRegion] = useState<string | null>(null);
  const graphRef = useRef<ForceGraphHandle>(null);
  const universeRef = useRef<UniverseHandle>(null);
  const renderThumbnail = useCallback(
    (kind: CelestialKind, surface: string) => universeRef.current?.thumbnail(kind, surface) ?? null,
    [],
  );
  const { view, styles, changeView, changeStyle: persistStyle } = useUniversePreferences();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [path, setPath] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searched, setSearched] = useState(false);
  const searchController = useRef<AbortController | null>(null);
  const exploration = useMemo(() => constellationPreview(locale), [locale]);
  const [library, setGraph] = useState<Graph>({ nodes: [], edges: [] }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [selected, setSelected] = useState<string | null>(
      initialMode === "explore" ? "explore-0" : null,
    ),
    [edgeId, setEdgeId] = useState<string | null>(null);
  const { reduced } = useSpace();
  const environment = useMotionEnvironment();
  const graph = mode === "explore" ? exploration.graph : library;
  const universe = useMemo(() => universeLayout(graph), [graph]);
  const body = universe.bodies.find((body) => body.id === selected);
  const activeStyle = body
    ? styles[body.id] && appearancesFor(body.kind)[styles[body.id].surface]
      ? styles[body.id]
      : { surface: defaultSurface(body.kind, body.seed) }
    : null;
  useEffect(() => () => searchController.current?.abort(), []);
  function changeStyle(style: CelestialStyle) {
    if (body) persistStyle(body.id, style);
  }
  function activeRenderer() {
    return view === "3d" ? universeRef.current : graphRef.current;
  }
  const paused =
    reduced ||
    !environment.visible ||
    environment.dialogOpen ||
    previewOpen ||
    userPaused ||
    !graph.nodes.length;
  useEffect(() => {
    if (mode === "explore") return;
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api.memoryGraph(controller.signal);
        if (!controller.signal.aborted) {
          setGraph(result);
          setSelected((current) =>
            result.nodes.some((node) => node.id === current) ? current : null,
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refresh, mode]);
  const pending = mode === "library" && loading;
  function changeMode(next: GraphMode) {
    if (next === mode) return;
    setMode(next);
    setSelected(next === "explore" ? "explore-0" : null);
    setEdgeId(null);
    setPreviewOpen(false);
    searchController.current?.abort();
    setHits([]);
    setPath([]);
    setSearched(false);
    setSearchError("");
    setSearching(false);
  }
  function selectNode(id: string) {
    setSelected(id);
    setEdgeId(null);
  }
  async function recall() {
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    setSearchError("");
    setSearched(true);
    try {
      if (mode === "explore") {
        const first = graph.nodes.find((node) =>
          node.title.toLowerCase().includes(query.trim().toLowerCase()),
        );
        const ids = first ? [first.id, ...(universe.neighbors.get(first.id) ?? [])] : [];
        setPath(ids);
        setHits([]);
        if (first) selectNode(first.id);
      } else {
        const result = await api.memorySearch(query.trim(), [], controller.signal);
        if (controller.signal.aborted) return;
        setHits(result.items);
        setPath([
          ...new Set(
            result.items.flatMap((hit) => hit.path?.map((step) => step.note_id) ?? [hit.note_id]),
          ),
        ]);
        const first = result.items.find((hit) =>
          graph.nodes.some((node) => node.id === hit.note_id),
        );
        if (first) selectNode(first.note_id);
      }
    } catch (error) {
      if (!controller.signal.aborted) setSearchError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }
  function openNote(id: string) {
    if (mode === "explore") {
      setSelected(id);
      setPreviewOpen(true);
    } else onOpen(id);
  }
  const node = graph.nodes.find((node) => node.id === selected),
    edge = graph.edges.find((edge) => edge.id === edgeId);
  return (
    <section
      className={`memory-graph force-graph-workspace ${reduced ? "still" : ""}`}
      aria-label={t("真实关系星图")}
    >
      <header>
        <div>
          <h2>{t("记忆星图")}</h2>
          <p>
            {mode === "explore"
              ? t("{0} 个主题 · {1} 条知识连接", [graph.nodes.length, graph.edges.length])
              : t("{0} 个文档 · {1} 条已确认关系", [graph.nodes.length, graph.edges.length])}
          </p>
        </div>
        <div className="notes-actions">
          <ActionButton
            className="secondary-button graph-motion-control"
            disabled={reduced || !graph.nodes.length}
            aria-pressed={userPaused}
            onClick={() => setUserPaused((current) => !current)}
          >
            {userPaused ? <Play size={14} /> : <Pause size={14} />}
            {userPaused ? t("继续运动") : t("暂停运动")}
          </ActionButton>
          <ActionButton
            className="secondary-button"
            onClick={() => activeRenderer()?.zoomBy(1 / 1.15)}
            aria-label={t("缩小星图")}
          >
            <ZoomOut size={16} />
          </ActionButton>
          <ActionButton
            className="secondary-button"
            onClick={() => activeRenderer()?.zoomBy(1.15)}
            aria-label={t("放大星图")}
          >
            <ZoomIn size={16} />
          </ActionButton>
          <ActionButton
            className="secondary-button"
            onClick={() => {
              if (view === "3d") setSelected(null);
              activeRenderer()?.reset();
            }}
          >
            <RotateCcw size={14} />
            {t("复位星图")}
          </ActionButton>
          {mode === "library" && (
            <ActionButton
              className="secondary-button"
              disabled={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              {t("刷新关系")}
            </ActionButton>
          )}
        </div>
      </header>
      <div className="graph-mode-bar">
        <div className="graph-mode-switch" role="group" aria-label={t("星图模式")}>
          {(["library", "explore"] as const).map((option) => (
            <ActionButton
              key={option}
              aria-pressed={mode === option}
              onClick={() => changeMode(option)}
            >
              {option === "library" ? (
                t("我的知识")
              ) : (
                <>
                  <Compass size={14} />
                  {t("探索星图")}
                </>
              )}
              {mode === option && (
                <motion.span className="active-tab-surface" layoutId="graph-mode" />
              )}
            </ActionButton>
          ))}
        </div>
        <div className="graph-view-switch" role="group" aria-label={t("图谱展示方式")}>
          <ActionButton aria-pressed={view === "3d"} onClick={() => changeView("3d")}>
            <Orbit size={14} />
            {t("三维宇宙")}
          </ActionButton>
          <ActionButton aria-pressed={view === "2d"} onClick={() => changeView("2d")}>
            <Network size={14} />
            {t("二维图谱")}
          </ActionButton>
        </div>
        <span className="graph-mode-note">
          {mode === "explore" ? t("体验模式 · 不写入记忆库") : t("来自你的本地记忆库")}
        </span>
      </div>
      {view === "3d" && Boolean(universe.regions.length) && (
        <div className="universe-region-tabs" role="group" aria-label={t("切换星域")}>
          {universe.regions.map((region) => (
            <ActionButton
              key={region.id}
              className="text-button"
              aria-pressed={(activeRegion ?? body?.region) === region.id}
              onClick={() => {
                setSelected(null);
                universeRef.current?.enterRegion(region.id);
              }}
            >
              {region.label || t("未分类")}
            </ActionButton>
          ))}
          <ActionButton
            className="text-button"
            onClick={() => {
              setSelected(null);
              universeRef.current?.reset();
            }}
          >
            {t("星域全景")}
          </ActionButton>
        </div>
      )}
      {mode === "library" && error && (
        <p className="inline-error" role="alert">
          {uiMessage(error)}
        </p>
      )}
      {pending && (
        <p role="status" className="notes-hint">
          {t("正在读取关系…")}
        </p>
      )}
      {mode === "library" && graph.truncated && (
        <p className="notes-hint">{t("星图显示部分文档，检索仍会查询本地记忆库")}</p>
      )}
      {!pending && mode === "library" && !error && !graph.nodes.length && (
        <div className="graph-empty-state">
          <Compass size={24} />
          <div>
            <strong>{t("等待你的第一颗记忆星点")}</strong>
            <p>{t("文档和关联会逐渐组成你的知识星图")}</p>
          </div>
          <ActionButton className="secondary-button" onClick={() => changeMode("explore")}>
            {t("探索星图")}
            <ArrowUpRight size={15} />
          </ActionButton>
        </div>
      )}
      <div
        className={`graph-layout ${!graph.nodes.length && !pending ? "graph-vacant" : ""} ${view === "3d" && !node ? "atlas-navigating" : ""}`}
      >
        {view === "3d" ? (
          graph.nodes.length ? (
            <UniverseGraph
              ref={universeRef}
              graph={graph}
              paused={paused}
              selected={selected}
              styles={styles}
              path={path}
              onSelect={selectNode}
              onRunning={setCanvasRunning}
              onRegionChange={setActiveRegion}
              onClear={() => {
                setSelected(null);
                setEdgeId(null);
              }}
            />
          ) : (
            <div className="universe-scene" />
          )
        ) : (
          <ForceGraph
            ref={graphRef}
            graph={graph}
            paused={paused}
            selected={selected}
            edgeId={edgeId}
            onSelect={selectNode}
            onEdge={(id) => {
              const relation = graph.edges.find((item) => item.id === id);
              if (relation) {
                setEdgeId(id);
                setSelected(relation.source);
              }
            }}
            onRunning={setCanvasRunning}
          />
        )}
        <aside className="graph-details" hidden={view === "3d" && !node}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={node?.id ?? "unselected"}
              initial={reduced ? false : { opacity: 0, y: 7 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduced ? 0 : -5 }}
              transition={{ duration: reduced ? 0 : 0.16 }}
            >
              {node ? (
                <>
                  <ActionButton
                    className="icon-button graph-detail-close"
                    aria-label={t("关闭节点详情")}
                    onClick={() => {
                      setSelected(null);
                      setEdgeId(null);
                    }}
                  >
                    <X size={16} />
                  </ActionButton>
                  <p className="eyebrow">{mode === "explore" ? t("知识连接") : t("已选文档")}</p>
                  <h3>{node.title}</h3>
                  {view === "3d" && (
                    <p
                      className="atlas-document-status"
                      data-knowledge={node.has_knowledge ? "recorded" : "empty"}
                    >
                      {node.has_knowledge ? t("已记录知识") : t("待记录知识")}
                    </p>
                  )}
                  <p className="notes-hint">{node.folder || t("根目录")}</p>
                  <div className="note-tags">
                    {node.tags.map((tag) => (
                      <span key={tag.id}>{tag.name}</span>
                    ))}
                  </div>
                  {mode === "explore" && (
                    <p className="graph-topic-description">{exploration.descriptions[node.id]}</p>
                  )}
                  {view === "3d" && body && activeStyle && (
                    <CelestialPicker
                      key={body.id}
                      kind={body.kind}
                      value={activeStyle}
                      onChange={changeStyle}
                      renderer={renderThumbnail}
                    />
                  )}
                  <ActionButton className="primary-button" onClick={() => openNote(node.id)}>
                    {mode === "explore" ? t("查看主题") : t("打开文档")}
                    <ArrowUpRight size={14} />
                  </ActionButton>
                  <h4>{mode === "explore" ? t("相关主题") : t("关联与证据")}</h4>
                  {graph.edges
                    .filter(
                      (relation) => relation.source === node.id || relation.target === node.id,
                    )
                    .map((relation) => (
                      <ActionButton
                        key={relation.id}
                        className="graph-relation"
                        onClick={() => {
                          setEdgeId(relation.id);
                        }}
                        aria-pressed={edgeId === relation.id}
                      >
                        {relation.relation} ·{" "}
                        {graph.nodes.find(
                          (item) =>
                            item.id ===
                            (relation.source === node.id ? relation.target : relation.source),
                        )?.title ?? t("关联文档")}
                      </ActionButton>
                    ))}
                  {edge && (
                    <div className="graph-evidence">
                      <strong>{edge.relation}</strong>
                      {mode === "library" && (
                        <time dateTime={edge.created_at}>{uiDate(edge.created_at)}</time>
                      )}
                      <p>{edge.evidence}</p>
                      {edge.source_message_id && (
                        <p className="notes-hint">{t("来源：原始对话")}</p>
                      )}
                      <ActionButton
                        className="text-button"
                        onClick={() => {
                          const target = edge.source === node.id ? edge.target : edge.source;
                          if (mode === "explore") {
                            selectNode(target);
                          } else onOpen(target);
                        }}
                      >
                        {t("阅读关联文档")}
                      </ActionButton>
                    </div>
                  )}
                </>
              ) : (
                <p className="notes-hint">
                  {t(
                    view === "3d"
                      ? "选择星系进入，悬停光点查看关联，点击知识节点靠近星球并阅读文档。"
                      : "选择一颗星查看文档与关系证据。可拖拽节点、移动画布；用缩放按钮或滚轮缩放。键盘方向键可移动选中节点。",
                  )}
                </p>
              )}
            </motion.div>
          </AnimatePresence>
        </aside>
      </div>
      <div className="graph-canvas-footer">
        <span className="graph-motion-status">
          <span className={canvasRunning ? "moving-dot" : ""} />
          {reduced ? t("静态星图") : canvasRunning ? t("缓慢漂移中") : t("运动已暂停")}
        </span>
        <span className="graph-weight-hint">
          {view === "3d" ? t("天体大小表示关联权重") : t("星点大小表示关联数量")}
        </span>
        <p className="graph-canvas-hint">
          {view === "3d"
            ? t("拖拽旋转 · 滚轮缩放 · 点击天体查看文档")
            : t("悬浮高亮关联 · 拖拽节点与画布 · 滚轮缩放")}
        </p>
      </div>
      <form
        className="graph-recall"
        onSubmit={(event) => {
          event.preventDefault();
          void recall();
        }}
      >
        <label htmlFor="graph-recall-query">
          <Search size={15} />
          <span>{t("沿着关联唤起记忆")}</span>
        </label>
        <div>
          <input
            id="graph-recall-query"
            value={query}
            maxLength={200}
            placeholder={t("输入你想回忆的知识")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ActionButton className="primary-button" disabled={searching || !query.trim()}>
            {searching ? t("检索中…") : t("唤起记忆")}
          </ActionButton>
        </div>
        {searchError && (
          <p className="inline-error" role="alert">
            {uiMessage(searchError)}
          </p>
        )}
        {searched && !searching && !searchError && (
          <div className="graph-recall-results" aria-live="polite">
            {mode === "library" ? (
              hits.length ? (
                hits.slice(0, 6).map((hit, index) => (
                  <ActionButton
                    key={`${hit.note_id}-${index}`}
                    className="text-button"
                    onClick={() => onOpen(hit.note_id)}
                  >
                    {hit.title}
                    <span>{hit.hop ? t("沿 {0} 跳关联找到", [hit.hop]) : t("直接命中")}</span>
                    <ArrowUpRight size={12} />
                  </ActionButton>
                ))
              ) : (
                <p>{t("没有找到相关章节。")}</p>
              )
            ) : (
              <p>{path.length ? t("已点亮相关主题") : t("没有找到相关主题")}</p>
            )}
          </div>
        )}
      </form>
      <details className="graph-accessible-list">
        <summary>{t("文档与关系列表")}</summary>
        {graph.nodes.map((item) => (
          <ActionButton
            className="secondary-button"
            key={item.id}
            onClick={() => selectNode(item.id)}
          >
            {item.title}
          </ActionButton>
        ))}
        {graph.edges.map((relation) => (
          <ActionButton
            className="secondary-button"
            key={relation.id}
            onClick={() => {
              setEdgeId(relation.id);
              setSelected(relation.source);
            }}
          >
            {relation.relation}
            {t("· 查看证据")}
          </ActionButton>
        ))}
      </details>
      <Modal
        open={previewOpen && Boolean(node)}
        onOpenChange={setPreviewOpen}
        title={node?.title ?? ""}
        description={t("探索内容仅用于体验，不会保存在你的记忆库")}
      >
        <div className="preview-topic">
          <p>{node ? exploration.descriptions[node.id] : ""}</p>
          <h3>{t("相关主题")}</h3>
          <div className="preview-connections">
            {graph.edges
              .filter((relation) => relation.source === selected || relation.target === selected)
              .map((relation) => {
                const target = graph.nodes.find(
                  (item) =>
                    item.id === (relation.source === selected ? relation.target : relation.source),
                );
                return (
                  target && (
                    <ActionButton
                      className="secondary-button"
                      key={relation.id}
                      onClick={() => {
                        selectNode(target.id);
                      }}
                    >
                      {target.title}
                      <ArrowUpRight size={14} />
                    </ActionButton>
                  )
                );
              })}
          </div>
        </div>
      </Modal>
    </section>
  );
}
