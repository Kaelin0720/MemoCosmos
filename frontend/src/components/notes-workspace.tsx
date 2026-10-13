"use client";
import { t, uiDate, uiMessage, useLocale } from "@/lib/i18n";
import { WorkspaceSurface } from "@/components/motion-system";
import { Entrance, useQuietMotion } from "./motion-system";
import { AnimatePresence, motion } from "motion/react";
import { api, errorMessage } from "@/lib/api";
import type { MemoryGraph as Graph } from "@/lib/memory-types";
import { NoteRelations } from "./note-relations";
import { ActionButton } from "@/components/motion-system";

import {
  BookOpen,
  FileText,
  Plus,
  RefreshCw,
  Tags,
  Compass,
  ArrowUpRight,
  ShieldCheck,
  Network,
  MessageCircle,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { notesStore, draftIsDirty } from "@/lib/notes-store";
import { isNoteId, textLength, type NoteSummary } from "@/lib/note-types";
import { ChatMarkdown, headingId } from "./chat-markdown";
import { FolderTree } from "./folder-tree";
import { ExternalCompare, NoteHistory, NoteReconcile } from "./note-history";
import { MemoryJobs } from "./memory-jobs";
import { MemoryGraph } from "./memory-graph";
import { MemorySearch } from "./memory-search";
import { Modal } from "./ui";

function localDate(value: string) {
  return uiDate(value);
}

function SyncBadge({ note }: { note: NoteSummary }) {
  useLocale();
  return (
    <span className={`note-sync ${note.sync_status}`}>
      <i aria-hidden="true" />
      {
        { synced: t("已同步"), pending: t("同步未完成"), conflict: t("文件有冲突") }[
          note.sync_status
        ]
      }
    </span>
  );
}
function NoteTags({ tags }: { tags: NoteSummary["tags"] }) {
  useLocale();
  return (
    <div className="note-tags">
      {tags.length ? (
        tags.map((tag) => <span key={tag.id}>{tag.name}</span>)
      ) : (
        <span className="uncategorized">{t("未分类")}</span>
      )}
    </div>
  );
}
function setLocation(id: string | null, draft = false) {
  const query = id ? `?note=${encodeURIComponent(id)}` : draft ? "?draft=1" : "";
  const next = `/knowledge/${query}`;
  if (`${window.location.pathname}${window.location.search}` !== next)
    window.history.pushState(null, "", next);
}

export function NotesWorkspace() {
  useLocale();
  const state = useSyncExternalStore(
    notesStore.subscribe,
    notesStore.snapshot,
    notesStore.serverSnapshot,
  );
  const params = useSearchParams(),
    selected = params.get("note"),
    draftRoute = params.get("draft") === "1";
  const [preview, setPreview] = useState(false),
    [discardOpen, setDiscardOpen] = useState(false);
  const [view, setView] = useState<"documents" | "graph" | "jobs">(
    params.get("view") === "graph" ? "graph" : "documents",
  );
  const [graphMode, setGraphMode] = useState<"library" | "explore">(
    params.get("mode") === "explore" ? "explore" : "library",
  );
  const [titleQuery, setTitleQuery] = useState(() => notesStore.snapshot().query.q ?? "");
  const [tagFilter, setTagFilter] = useState(() => notesStore.snapshot().query.tag_id ?? "");
  const [appliedFilters, setAppliedFilters] = useState(state.query);
  if (appliedFilters.q !== state.query.q || appliedFilters.tag_id !== state.query.tag_id) {
    setAppliedFilters(state.query);
    setTitleQuery(state.query.q ?? "");
    setTagFilter(state.query.tag_id ?? "");
  }
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [draftPicker, setDraftPicker] = useState(false);
  const reduced = useQuietMotion();
  const [graph, setGraph] = useState<Graph | null>(null),
    [graphError, setGraphError] = useState("");
  const catalogVersion = state.catalog
    .map((note) => `${note.id}:${note.version}:${note.sync_status}`)
    .sort()
    .join("|");
  useEffect(() => {
    const controller = new AbortController();
    void api
      .memoryGraph(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setGraph(result);
          setGraphError("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setGraphError(errorMessage(error));
      });
    return () => controller.abort();
  }, [catalogVersion]);
  const dirty = draftIsDirty(state.draft);
  const invalidIds = state.tagsReady
    ? state.draft.tag_ids.filter((id) => !state.tags.some((tag) => tag.id === id))
    : [];
  const badAddress = selected !== null && !isNoteId(selected);

  useEffect(() => {
    async function refreshCurrent() {
      await notesStore.refresh();
      const current = notesStore.snapshot();
      if (current.mode === "browse" && current.selectedId) void notesStore.open(current.selectedId);
    }
    void refreshCurrent();
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") void refreshCurrent();
    };
    document.addEventListener("visibilitychange", refreshOnFocus);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      document.removeEventListener("visibilitychange", refreshOnFocus);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, []);
  useEffect(() => {
    if (draftRoute) notesStore.resume();
    else if (isNoteId(selected)) void notesStore.open(selected);
    else if (!selected) {
      const current = notesStore.snapshot();
      if (current.mode === "browse" && current.selectedId) void notesStore.open(current.selectedId);
    }
  }, [selected, draftRoute]);
  useEffect(() => {
    // Browser history can move before Next updates useSearchParams. Read the
    // restored URL immediately so a slower detail request cannot leave the
    // previously selected document on screen after Back or Forward.
    const restoreHistory = () => {
      const query = new URLSearchParams(window.location.search);
      const id = query.get("note");
      if (isNoteId(id)) void notesStore.open(id);
      else if (query.get("draft") === "1") notesStore.resume();
    };
    window.addEventListener("popstate", restoreHistory);
    return () => window.removeEventListener("popstate", restoreHistory);
  }, []);

  useEffect(() => {
    const timer = setTimeout(
      () =>
        notesStore.setQuery({
          ...notesStore.snapshot().query,
          q: titleQuery.trim(),
          tag_id: tagFilter || undefined,
        }),
      250,
    );
    return () => clearTimeout(timer);
  }, [titleQuery, tagFilter]);
  useEffect(() => {
    if (!state.detail || !window.location.hash) return;
    try {
      document
        .getElementById(headingId(decodeURIComponent(window.location.hash.slice(1))))
        ?.scrollIntoView();
    } catch {
      /* malformed anchor has no effect */
    }
  }, [state.detail]);
  function open(id: string, heading?: string) {
    setView("documents");
    setLocation(id);
    if (heading)
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#${encodeURIComponent(headingId(heading))}`,
      );
    void notesStore.open(id);
  }
  function create() {
    setView("documents");
    notesStore.create();
    setLocation(null, true);
  }
  function resume(key?: string) {
    setView("documents");
    notesStore.resume(key);
    setLocation(null, true);
  }
  function edit() {
    // A route morph can still show the previous reader for a frame. Resolve
    // the document at the time of the action, rather than its render closure.
    const current = notesStore.snapshot();
    if (current.reading || !current.detail || current.detail.id !== current.selectedId) return;
    notesStore.startEdit(current.detail);
    resume();
  }
  async function refresh() {
    await notesStore.refresh();
    const current = notesStore.snapshot();
    if (current.mode === "browse" && current.selectedId) void notesStore.open(current.selectedId);
  }
  async function save() {
    const id = await notesStore.save();
    if (id && window.location.pathname === "/knowledge/" && notesStore.snapshot().mode === "create")
      open(id);
  }
  const notice = state.notice;
  return (
    <WorkspaceSurface className="notes-workspace glass-panel" aria-label={t("主题文档工作区")}>
      <header className="notes-heading">
        <div>
          <p className="eyebrow">{t("知识宇宙 / 个人记忆库")}</p>
          <h1>{t("主题文档")}</h1>
          <p>{t("助手从对话中整理知识，你随时补充与修改。")}</p>
        </div>
        <div className="notes-actions">
          <ActionButton
            className="secondary-button"
            onClick={() => void refresh()}
            disabled={state.listLoading || state.tagsLoading}
          >
            <RefreshCw size={15} className={state.listLoading ? "spin" : ""} />
            {t("刷新目录")}
          </ActionButton>
          {state.hasDrafts && (
            <ActionButton
              className="secondary-button"
              onClick={() => (state.draftEntries.length > 1 ? setDraftPicker(true) : resume())}
            >
              {t("继续草稿")}
            </ActionButton>
          )}
          <ActionButton className="primary-button" onClick={create}>
            <Plus size={16} />
            {t("新建文档")}
          </ActionButton>
        </div>
      </header>
      <nav className="knowledge-tabs" aria-label={t("知识视图")}>
        <ActionButton aria-pressed={view === "documents"} onClick={() => setView("documents")}>
          {t("文档与目录")}
          {view === "documents" && (
            <motion.span
              className="active-tab-surface"
              layoutId="knowledge-tab"
              transition={reduced ? { duration: 0 } : undefined}
            />
          )}
        </ActionButton>
        <ActionButton aria-pressed={view === "graph"} onClick={() => setView("graph")}>
          {t("关系星图")}
          {view === "graph" && (
            <motion.span
              className="active-tab-surface"
              layoutId="knowledge-tab"
              transition={reduced ? { duration: 0 } : undefined}
            />
          )}
        </ActionButton>
        <ActionButton aria-pressed={view === "jobs"} onClick={() => setView("jobs")}>
          {t("整理与确认")}
          {view === "jobs" && (
            <motion.span
              className="active-tab-surface"
              layoutId="knowledge-tab"
              transition={reduced ? { duration: 0 } : undefined}
            />
          )}
        </ActionButton>
      </nav>
      {notice && (
        <div
          className={`note-notice ${notice.kind}`}
          role={notice.kind === "success" ? "status" : "alert"}
        >
          <p>{uiMessage(notice.message)}</p>
          {notice.details.sync_status && (
            <span>
              {t("同步状态：")}
              {
                { synced: t("已同步"), pending: t("未完成"), conflict: t("冲突") }[
                  notice.details.sync_status
                ]
              }
            </span>
          )}
          <div className="notes-actions">
            {notice.details.note_id && (
              <ActionButton
                className="secondary-button"
                onClick={() => open(notice.details.note_id!)}
              >
                {notice.kind === "success" ? t("查看已保存文档") : t("打开原文")}
                <BookOpen size={15} />
              </ActionButton>
            )}
            {notice.kind === "uncertain" && (
              <ActionButton className="secondary-button" onClick={() => void refresh()}>
                {t("读取目录核对")}
              </ActionButton>
            )}
            {notice.code === "note_version_conflict" && state.draft.base && (
              <NoteReconcile
                key={state.draft.base.id}
                id={state.draft.base.id}
                onEdit={() => resume()}
              />
            )}
          </div>
        </div>
      )}
      <AnimatePresence mode="popLayout" initial={false}>
        {view === "graph" && (
          <Entrance key="graph">
            <MemoryGraph onOpen={open} initialMode={graphMode} />
          </Entrance>
        )}
        {view === "jobs" && (
          <Entrance key="jobs">
            <MemoryJobs onChanged={() => void notesStore.refresh()} />
          </Entrance>
        )}
      </AnimatePresence>
      <motion.div
        className={`notes-content ${directoryOpen ? "" : "directory-collapsed"}`}
        layout={!reduced}
        style={view === "documents" ? undefined : { display: "none" }}
      >
        <ActionButton
          className="directory-toggle secondary-button"
          onClick={() => setDirectoryOpen((value) => !value)}
          aria-expanded={directoryOpen}
        >
          {directoryOpen ? t("收起目录") : t("展开目录")}
        </ActionButton>
        <motion.aside
          className="notes-directory"
          aria-label={t("文档目录")}
          aria-hidden={!directoryOpen || undefined}
          inert={!directoryOpen}
          initial={false}
          animate={{ opacity: directoryOpen ? 1 : 0, height: directoryOpen ? "auto" : 0 }}
          transition={reduced ? { duration: 0 } : { duration: 0.25 }}
        >
          <div className="notes-directory-title">
            <FileText size={16} />
            <h2>{t("文档目录")}</h2>
            <span>
              {state.total}
              {t("篇")}
            </span>
          </div>
          <div className="note-filters">
            <label htmlFor="note-title-search">{t("按标题查找")}</label>
            <input
              id="note-title-search"
              value={titleQuery}
              onChange={(event) => setTitleQuery(event.target.value)}
              placeholder={t("输入标题关键词")}
            />
            <label htmlFor="note-tag-filter">{t("标签筛选")}</label>
            <select
              id="note-tag-filter"
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
            >
              <option value="">{t("全部标签")}</option>
              {state.tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
            {state.query.folder !== undefined && (
              <ActionButton
                className="folder-select"
                onClick={() => notesStore.setQuery({ ...state.query, folder: undefined })}
              >
                {t("目录：")}
                {state.query.folder || t("根目录")}
                {t("· 清除")}
              </ActionButton>
            )}
          </div>
          <FolderTree
            notes={state.items}
            selected={state.query.folder}
            selectedId={state.selectedId}
            onFolder={(folder) => notesStore.setQuery({ ...state.query, folder })}
            onNote={open}
          />
          {state.listLoading && (
            <p className="notes-hint" role="status">
              {t("正在读取目录…")}
            </p>
          )}
          {state.listError && (
            <div className="notes-inline-error" role="alert">
              <p>{uiMessage(state.listError)}</p>
              {state.items.length > 0 && <small>{t("下方是上次读取的目录，可能已变化。")}</small>}
            </div>
          )}
          {!state.listLoading && !state.listError && state.items.length === 0 && (
            <div className="notes-empty">
              <FileText size={25} />
              <p>
                {titleQuery || tagFilter || state.query.folder !== undefined
                  ? t("没有匹配的主题文档")
                  : t("还没有主题文档")}
              </p>
              <small>{t("新建文档，选择已有标签后保存。")}</small>
            </div>
          )}
          <Link href="/tags/" className="notes-tag-link">
            <Tags size={15} />
            {t("管理标签池")}
          </Link>
          <MemorySearch tagId={tagFilter || undefined} onOpen={open} />
        </motion.aside>
        <motion.div layout className="notes-document">
          <AnimatePresence mode="wait" initial={false}>
            {state.mode === "create" ? (
              <motion.form
                layout
                key="editor"
                initial={reduced ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduced ? 0 : -6 }}
                className="note-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <div className="note-form-heading">
                  <div>
                    <p className="eyebrow">
                      {state.draft.base
                        ? t("编辑文档 / 基于版本 {0}", [state.draft.base.version])
                        : t("新文档 / 会话内草稿")}
                    </p>
                    <h2>{state.draft.base ? t("继续完善这个主题") : t("记录一个主题")}</h2>
                  </div>
                  {dirty && (
                    <ActionButton
                      type="button"
                      className="secondary-button"
                      disabled={state.saving}
                      onClick={() => setDiscardOpen(true)}
                    >
                      {t("清空草稿")}
                    </ActionButton>
                  )}
                </div>
                <p className="notes-hint">{t("草稿在站内切换时保留；刷新或关闭后不会恢复。")}</p>
                <div className="field">
                  <label htmlFor="note-title">
                    {t("标题 ")}
                    <span>{textLength(state.draft.title.trim())} / 200</span>
                  </label>
                  <input
                    id="note-title"
                    autoComplete="off"
                    placeholder={t("给这个主题起个名字")}
                    value={state.draft.title}
                    onChange={(event) => notesStore.edit({ title: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="note-folder">
                    {t("归档目录 ")}
                    <span>{t("选填 · 用 / 分隔")}</span>
                  </label>
                  <input
                    id="note-folder"
                    placeholder={t("例如：开发/缓存")}
                    value={state.draft.folder ?? ""}
                    onChange={(event) => notesStore.edit({ folder: event.target.value })}
                  />
                  <p className="field-help">
                    {t("留空放在根目录；调整归档位置后，原有引用仍可使用。")}
                  </p>
                </div>
                <fieldset className="note-tag-picker">
                  <legend>
                    {t("已有标签")}{" "}
                    <span>
                      {state.draft.base ? t("可解除分类，最多 64 个") : t("至少选一个，最多 64 个")}
                    </span>
                  </legend>
                  {state.tagsLoading && <p className="notes-hint">{t("正在读取标签…")}</p>}
                  {state.tagsError && (
                    <p role="alert" className="notes-inline-error">
                      {uiMessage(state.tagsError)}
                    </p>
                  )}
                  {state.tagsReady && !state.tags.length && (
                    <p className="notes-hint">{t("标签池还是空的，请先创建一个标签。")}</p>
                  )}
                  <div className="note-tag-options">
                    {state.tags.map((tag) => (
                      <label key={tag.id}>
                        <input
                          type="checkbox"
                          checked={state.draft.tag_ids.includes(tag.id)}
                          onChange={(event) =>
                            notesStore.edit({
                              tag_ids: event.target.checked
                                ? [...state.draft.tag_ids, tag.id]
                                : state.draft.tag_ids.filter((id) => id !== tag.id),
                            })
                          }
                        />
                        <span>{tag.name}</span>
                      </label>
                    ))}
                  </div>
                  {invalidIds.length > 0 && (
                    <div className="notes-inline-error" role="alert">
                      <p>{t("所选标签已失效，请移除后重新选择。")}</p>
                      {invalidIds.map((id) => (
                        <ActionButton
                          key={id}
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            notesStore.edit({
                              tag_ids: state.draft.tag_ids.filter((value) => value !== id),
                            })
                          }
                        >
                          {t("移除失效标签")}
                        </ActionButton>
                      ))}
                    </div>
                  )}
                  <div className="notes-actions">
                    <Link href="/tags/" className="notes-tag-link">
                      {t("去标签池新建 ")}
                      <Tags size={14} />
                    </Link>
                    <ActionButton
                      type="button"
                      className="text-button"
                      onClick={() => void notesStore.refreshTags()}
                      disabled={state.tagsLoading}
                    >
                      {t("重新读取标签")}
                    </ActionButton>
                  </div>
                </fieldset>
                <div className="note-body-heading">
                  <label htmlFor="note-body">
                    {t("Markdown 正文 ")}
                    <span>{textLength(state.draft.body)} / 200000</span>
                  </label>
                  <ActionButton
                    type="button"
                    className="secondary-button"
                    aria-pressed={preview}
                    onClick={() => setPreview((value) => !value)}
                  >
                    {preview ? t("继续输入") : t("阅读预览")}
                  </ActionButton>
                </div>
                {preview ? (
                  <div className="note-preview" aria-label={t("草稿预览")}>
                    {state.draft.body ? (
                      <ChatMarkdown content={state.draft.body} />
                    ) : (
                      <p className="notes-hint">{t("正文可以留空。")}</p>
                    )}
                  </div>
                ) : (
                  <div className="field">
                    <textarea
                      id="note-body"
                      spellCheck={false}
                      rows={12}
                      placeholder={t("用 Markdown 写下你的知识、经历或待理解的问题…")}
                      value={state.draft.body}
                      onChange={(event) => notesStore.edit({ body: event.target.value })}
                    />
                  </div>
                )}
                <div className="field">
                  <label htmlFor="note-source">
                    {t("出处 ")}
                    <span>
                      {t("选填 · ")}
                      {textLength(state.draft.source)} / 2000
                    </span>
                  </label>
                  <textarea
                    id="note-source"
                    rows={2}
                    placeholder={t("原文网址、书名或你自己的来源说明")}
                    value={state.draft.source}
                    onChange={(event) => notesStore.edit({ source: event.target.value })}
                  />
                </div>
                <div className="note-save-bar">
                  <p>
                    {state.saving
                      ? t("正在确认文件保存；你可以继续输入。")
                      : t("保存后可从目录打开全文。")}
                  </p>
                  <ActionButton
                    className="primary-button"
                    type="submit"
                    disabled={state.saving || state.tagsLoading || !state.tagsReady}
                  >
                    {state.saving ? (
                      <RefreshCw size={15} className="spin" />
                    ) : (
                      <FileText size={15} />
                    )}
                    {state.saving
                      ? t("正在保存…")
                      : state.draft.base
                        ? t("保存修改")
                        : t("保存文档")}
                  </ActionButton>
                </div>
              </motion.form>
            ) : (
              <motion.div
                key={`reader-${state.selectedId ?? "empty"}`}
                initial={reduced ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduced ? 0 : -6 }}
              >
                {dirty && (
                  <div className="note-retained">
                    <span>{t("有一份未保存的草稿，仍保留在本次会话中。")}</span>
                    <ActionButton className="secondary-button" onClick={() => resume()}>
                      {t("返回草稿")}
                    </ActionButton>
                  </div>
                )}
                {badAddress ? (
                  <div className="notes-inline-error" role="alert">
                    {t("文档地址无效，请从目录选择一篇文档。")}
                  </div>
                ) : state.reading ? (
                  <p className="notes-hint" role="status">
                    {t("正在读取原文并检查文件…")}
                  </p>
                ) : state.readError ? (
                  <div className="notes-read-error" role="alert">
                    <BookOpen size={28} />
                    <h2>{t("暂时无法读取原文")}</h2>
                    <p>{uiMessage(state.readError)}</p>
                    <p className="notes-hint">
                      {t("请检查本地文档后重新读取。")}
                      {dirty ? t("你的草稿仍保留。") : ""}
                    </p>
                    <ActionButton
                      className="secondary-button"
                      onClick={() => state.selectedId && void notesStore.open(state.selectedId)}
                    >
                      {t("重新读取原文")}
                    </ActionButton>
                    {state.selectedId &&
                      ["external_note_changed", "note_file_invalid"].includes(
                        state.readCode ?? "",
                      ) && (
                        <ExternalCompare
                          key={state.selectedId}
                          id={state.selectedId}
                          onImported={() => setView("documents")}
                        />
                      )}
                  </div>
                ) : state.detail ? (
                  <article className="note-reader" aria-label={t("文档原文")}>
                    <header>
                      <div className="note-reader-kicker">
                        <span>
                          {t("主题文档 · 版本 ")}
                          {state.detail.version}
                        </span>
                        <SyncBadge note={state.detail} />
                      </div>
                      <h2>{state.detail.title}</h2>
                      <p className="note-breadcrumb">
                        {state.detail.folder.split("/").filter(Boolean).join(" / ") || t("根目录")}{" "}
                        / {state.detail.title}
                      </p>
                      <div className="notes-actions">
                        <ActionButton className="primary-button" onClick={edit}>
                          {t("编辑文档")}
                        </ActionButton>
                        <NoteHistory
                          key={state.detail.id}
                          detail={state.detail}
                          onEdit={() => resume()}
                        />
                        <ActionButton
                          className="secondary-button"
                          onClick={() => setDeleteOpen(true)}
                        >
                          {t("删除笔记")}
                        </ActionButton>
                      </div>
                      <NoteTags tags={state.detail.tags} />
                      <NoteRelations
                        id={state.detail.id}
                        graph={graph}
                        error={uiMessage(graphError)}
                        onOpen={open}
                      />
                      <dl className="note-dates">
                        <div>
                          <dt>{t("创建")}</dt>
                          <dd>
                            <time dateTime={state.detail.created_at}>
                              {localDate(state.detail.created_at)}
                            </time>
                          </dd>
                        </div>
                        <div>
                          <dt>{t("修改")}</dt>
                          <dd>
                            <time dateTime={state.detail.updated_at}>
                              {localDate(state.detail.updated_at)}
                            </time>
                          </dd>
                        </div>
                      </dl>
                    </header>
                    {state.detail.body ? (
                      <ChatMarkdown content={state.detail.body} />
                    ) : (
                      <p className="notes-hint">{t("这篇文档的正文为空。")}</p>
                    )}
                    {state.detail.source && (
                      <div className="note-source">
                        <h3>{t("出处")}</h3>
                        <p>{state.detail.source}</p>
                      </div>
                    )}
                    <p className="notes-hint note-reader-foot">
                      {t("人工修改按当前版本保存；文档引用可点击打开。")}
                    </p>
                  </article>
                ) : (
                  <div className="notes-welcome">
                    <svg className="welcome-constellation" viewBox="0 0 240 115" aria-hidden="true">
                      <path d="M15 65L65 27L120 63L182 16L227 74M65 27L81 100L120 63L189 105L227 74" />
                      {[
                        [15, 65],
                        [65, 27],
                        [120, 63],
                        [182, 16],
                        [227, 74],
                        [81, 100],
                        [189, 105],
                      ].map(([x, y], i) => (
                        <circle
                          key={i}
                          cx={x}
                          cy={y}
                          r={i === 2 ? 4 : 2}
                          className={i === 2 ? "pulse-star" : undefined}
                        />
                      ))}
                    </svg>
                    <p className="eyebrow">{t("让知识有处可寻")}</p>
                    <h2>{t("从日常对话积累知识")}</h2>
                    <p>{t("聊聊学到的知识和做过的事情，助手会整理到这里；也可以手动补充记录。")}</p>
                    <div className="notes-welcome-actions">
                      <Link href="/" className="primary-button">
                        <MessageCircle size={15} />
                        {t("开始对话")}
                        <ArrowUpRight size={14} />
                      </Link>
                      <ActionButton
                        className="secondary-button"
                        onClick={() => {
                          setGraphMode("explore");
                          setView("graph");
                        }}
                      >
                        <Compass size={15} />
                        {t("探索星图")}
                      </ActionButton>
                    </div>
                    <div className="welcome-capabilities">
                      <span>
                        <ShieldCheck size={13} />
                        {t("记忆保存在本机")}
                      </span>
                      <span>
                        <FileText size={13} />
                        {t("随时编辑文档")}
                      </span>
                      <span>
                        <Network size={13} />
                        {t("知识彼此连接")}
                      </span>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
      <Modal
        open={draftPicker}
        onOpenChange={setDraftPicker}
        title={t("继续哪份草稿？")}
        description={t("草稿仅保留在本次打开的页面中，刷新或关闭后不会恢复。")}
      >
        <div className="version-list">
          {state.draftEntries.map((draft) => (
            <ActionButton
              key={draft.key}
              className="secondary-button"
              onClick={() => {
                resume(draft.key);
                setDraftPicker(false);
              }}
            >
              {draft.title}
              <small>{draft.editing ? t("编辑草稿") : t("新文档草稿")}</small>
            </ActionButton>
          ))}
        </div>
      </Modal>
      <Modal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        busy={state.saving}
        title={t("删除这篇笔记及其版本？")}
        description={t(
          "将删除笔记正文、版本与关联关系。原始聊天独立保留。若文件或版本已改变，会暂停删除。",
        )}
      >
        <p>{state.detail?.title}</p>
        {notice?.kind === "error" && (
          <p className="inline-error" role="alert">
            {uiMessage(notice.message)}
          </p>
        )}
        <div className="notes-actions">
          <ActionButton
            className="secondary-button"
            disabled={state.saving}
            onClick={() => setDeleteOpen(false)}
          >
            {t("保留笔记")}
          </ActionButton>
          <ActionButton
            className="danger-button"
            disabled={state.saving || !state.detail}
            onClick={() => {
              if (state.detail)
                void notesStore.remove(state.detail.id, state.detail.version).then((success) => {
                  if (success) {
                    setDeleteOpen(false);
                    setLocation(null);
                  }
                });
            }}
          >
            {t("确认删除笔记")}
          </ActionButton>
        </div>
      </Modal>
      <Modal
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t("清空这份草稿？")}
        description={t("尚未保存的标题、正文、标签与出处会被清空。已保存文档不受影响。")}
      >
        <div className="notes-actions">
          <ActionButton className="secondary-button" onClick={() => setDiscardOpen(false)}>
            {t("继续保留")}
          </ActionButton>
          <ActionButton
            className="primary-button"
            onClick={() => {
              notesStore.discard();
              setDiscardOpen(false);
            }}
          >
            {t("确认清空草稿")}
          </ActionButton>
        </div>
      </Modal>
    </WorkspaceSurface>
  );
}
