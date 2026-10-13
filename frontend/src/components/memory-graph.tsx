"use client";
import { t, uiDate, uiMessage, useLocale } from "@/lib/i18n";
import { ActionButton } from "@/components/motion-system";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { MemoryGraph as Graph } from "@/lib/memory-types";
import { useSpace } from "./space-shell";
import { useMotionEnvironment } from "./ambient-motion";
import { ForceGraph, type ForceGraphHandle } from "./force-graph";

import { ArrowUpRight, Compass, Pause, Play, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
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
  const graphRef = useRef<ForceGraphHandle>(null);
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
  }
  function selectNode(id: string) {
    setSelected(id);
    setEdgeId(null);
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
            onClick={() => graphRef.current?.zoomBy(1 / 1.15)}
            aria-label={t("缩小星图")}
          >
            <ZoomOut size={16} />
          </ActionButton>
          <ActionButton
            className="secondary-button"
            onClick={() => graphRef.current?.zoomBy(1.15)}
            aria-label={t("放大星图")}
          >
            <ZoomIn size={16} />
          </ActionButton>
          <ActionButton className="secondary-button" onClick={() => graphRef.current?.reset()}>
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
        <span className="graph-mode-note">
          {mode === "explore" ? t("体验模式 · 不写入记忆库") : t("来自你的本地记忆库")}
        </span>
      </div>
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
      <div className={`graph-layout ${!graph.nodes.length && !pending ? "graph-vacant" : ""}`}>
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
        <aside className="graph-details">
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
                  <p className="notes-hint">{node.folder || t("根目录")}</p>
                  <div className="note-tags">
                    {node.tags.map((tag) => (
                      <span key={tag.id}>{tag.name}</span>
                    ))}
                  </div>
                  {mode === "explore" && (
                    <p className="graph-topic-description">{exploration.descriptions[node.id]}</p>
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
                    "选择一颗星查看文档与关系证据。可拖拽节点、移动画布；用缩放按钮或滚轮缩放。键盘方向键可移动选中节点。",
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
        <span className="graph-weight-hint">{t("星点大小表示关联数量")}</span>
        <p className="graph-canvas-hint">{t("悬浮高亮关联 · 拖拽节点与画布 · 滚轮缩放")}</p>
      </div>
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
