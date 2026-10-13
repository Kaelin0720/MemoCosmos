"use client";
import { t, uiDate, uiMessage, useLocale } from "@/lib/i18n";
import { ActionButton } from "@/components/motion-system";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { notesStore, draftIsDirty } from "@/lib/notes-store";
import type { NoteDetail, NoteVersion, ExternalNote, NoteInput } from "@/lib/note-types";
import { ChatMarkdown } from "./chat-markdown";
import { Modal } from "./ui";

export function NoteHistory({ detail, onEdit }: { detail: NoteDetail; onEdit: () => void }) {
  useLocale();
  const [open, setOpen] = useState(false),
    [versions, setVersions] = useState<NoteVersion[]>([]),
    [selected, setSelected] = useState<NoteVersion | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [replace, setReplace] = useState<NoteVersion | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const page = await api.noteVersions(detail.id, controller.signal);
        if (!controller.signal.aborted) {
          setVersions(page.items);
          setSelected(page.items[0] ?? null);
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [open, detail.id, detail.version]);
  function restoreVersion(version: NoteVersion) {
    if (draftIsDirty(notesStore.snapshot().draft)) {
      setReplace(version);
      return;
    }
    notesStore.startEdit(detail, version);
    onEdit();
    setOpen(false);
  }
  return (
    <>
      <ActionButton className="secondary-button" onClick={() => setOpen(true)}>
        {t("版本记录")}
      </ActionButton>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t("版本记录")}
        description={t("查看最近 20 个已确认版本；恢复到草稿后，仍需按当前版本保存。")}
      >
        {error && (
          <p role="alert" className="inline-error">
            {uiMessage(error)}
          </p>
        )}
        {loading && <p role="status">{t("正在读取版本…")}</p>}
        <div className="version-layout">
          <div className="version-list">
            {versions.map((version) => (
              <ActionButton
                key={version.version}
                className="secondary-button"
                aria-pressed={selected?.version === version.version}
                onClick={() => setSelected(version)}
              >
                {t("版本 ")}
                {version.version}
                <small>{uiDate(version.created_at)}</small>
              </ActionButton>
            ))}
          </div>
          {selected && (
            <div className="version-preview">
              <h3>{selected.title}</h3>
              <p className="notes-hint">
                {selected.folder || t("根目录")} ·{" "}
                {{
                  manual: t("人工编辑"),
                  automatic: t("助手整理"),
                  auto: t("助手整理"),
                  external: t("外部导入"),
                  create: t("人工创建"),
                }[selected.origin] ?? t("已确认记录")}
              </p>
              <ChatMarkdown content={selected.body} />
              <ActionButton className="primary-button" onClick={() => restoreVersion(selected)}>
                {t("作为编辑草稿")}
              </ActionButton>
            </div>
          )}
        </div>
      </Modal>
      <Modal
        open={Boolean(replace)}
        onOpenChange={() => setReplace(null)}
        title={t("替换当前草稿？")}
        description={t("历史内容会成为新的编辑草稿，当前尚未保存的编辑内容将被替换。")}
      >
        <div className="notes-actions">
          <ActionButton className="secondary-button" onClick={() => setReplace(null)}>
            {t("保留现有草稿")}
          </ActionButton>
          <ActionButton
            className="primary-button"
            onClick={() => {
              if (replace) notesStore.startEdit(detail, replace, true);
              setReplace(null);
              setOpen(false);
              onEdit();
            }}
          >
            {t("确认使用历史内容")}
          </ActionButton>
        </div>
      </Modal>
    </>
  );
}

export function ExternalCompare({ id, onImported }: { id: string; onImported: () => void }) {
  useLocale();
  const [open, setOpen] = useState(false),
    [external, setExternal] = useState<ExternalNote | null>(null),
    [confirmed, setConfirmed] = useState<NoteVersion | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [checked, setChecked] = useState(false);
  const reader = useRef<AbortController | null>(null);
  useEffect(() => () => reader.current?.abort(), []);
  async function compare() {
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    setOpen(true);
    setBusy(true);
    setError("");
    setChecked(false);
    setExternal(null);
    setConfirmed(null);
    try {
      const [file, versions] = await Promise.all([
        api.externalNote(id, controller.signal),
        api.noteVersions(id, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (file.note_id !== id) throw new Error(t("文档身份不一致，请重新读取。"));
      setExternal(file);
      setConfirmed(
        versions.items.find((version) => version.version === file.current_version) ??
          versions.items[0] ??
          null,
      );
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function importFile() {
    if (!external || !checked || busy) return;
    setBusy(true);
    setError("");
    try {
      const detail = await api.importExternal(id, external.current_version, external.file_hash);
      if (detail.id !== id || detail.sync_status !== "synced")
        throw new Error(t("导入结果未确认，请重新读取核对。"));
      setOpen(false);
      await notesStore.refresh();
      await notesStore.open(id);
      onImported();
    } catch (error) {
      setError(t("{0} 原有草稿仍在会话内存中；请重新对比后再决定。", [errorMessage(error)]));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ActionButton className="secondary-button" onClick={() => void compare()}>
        {t("对比外部修改")}
      </ActionButton>
      <Modal
        open={open}
        onOpenChange={setOpen}
        busy={busy}
        title={t("外部文件对比")}
        description={t("外部内容尚未导入。导入将形成新版本，并保留文档 ID、现有目录和标签。")}
      >
        {error && (
          <p role="alert" className="inline-error">
            {uiMessage(error)}
          </p>
        )}
        {busy && !external && <p role="status">{t("正在读取受控文件…")}</p>}
        {external && (
          <>
            <div className="note-comparison">
              <section>
                <h3>{t("最后确认的版本")}</h3>
                {confirmed ? (
                  <>
                    <h4>{confirmed.title}</h4>
                    <ChatMarkdown content={confirmed.body} />
                  </>
                ) : (
                  <p>{t("没有可读取的确认版本。")}</p>
                )}
              </section>
              <section>
                <h3>{t("外部文件当前内容")}</h3>
                <h4>{external.title}</h4>
                <ChatMarkdown content={external.body} />
              </section>
            </div>
            <label className="memory-check">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => setChecked(event.target.checked)}
              />
              {t("我已核对，导入这份外部标题与正文")}
            </label>
            <div className="notes-actions">
              <ActionButton
                className="secondary-button"
                disabled={busy}
                onClick={() => void compare()}
              >
                {t("重新对比")}
              </ActionButton>
              <ActionButton
                className="primary-button"
                disabled={busy || !checked}
                onClick={() => void importFile()}
              >
                {t("确认导入外部修改")}
              </ActionButton>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

export function NoteReconcile({ id, onEdit }: { id: string; onEdit: () => void }) {
  useLocale();
  const [open, setOpen] = useState(false),
    [current, setCurrent] = useState<NoteDetail | null>(null),
    [input, setInput] = useState<NoteInput | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [checked, setChecked] = useState(false);
  const reader = useRef<AbortController | null>(null);
  const [previous, setPrevious] = useState<NoteInput | null>(null);
  useEffect(() => () => reader.current?.abort(), []);
  async function compare() {
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    setOpen(true);
    setLoading(true);
    setError("");
    setChecked(false);
    setCurrent(null);
    setInput(null);
    setPrevious({ ...notesStore.snapshot().draft });
    try {
      const detail = await api.note(id, controller.signal);
      if (controller.signal.aborted) return;
      if (detail.id !== id || detail.sync_status !== "synced")
        throw new Error(t("当前原文尚未确认，请重新读取。"));
      setCurrent(detail);
      setInput({
        title: detail.title,
        body: detail.body,
        folder: detail.folder,
        source: detail.source,
        tag_ids: detail.tags.map((tag) => tag.id),
      });
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <>
      <ActionButton className="secondary-button" onClick={() => void compare()}>
        {t("对照最新版本合并")}
      </ActionButton>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t("对照最新版本合并")}
        description={t(
          "合并区域从最新原文开始。请对照旧草稿，保留需要的内容；确认后只建立草稿，仍需手动保存。",
        )}
      >
        {loading && <p role="status">{t("正在读取当前版本…")}</p>}
        {error && (
          <p role="alert" className="inline-error">
            {uiMessage(error)}
          </p>
        )}
        {current && input && previous && (
          <>
            <div className="reconcile-layout">
              <section>
                <h3>{t("原有未保存草稿")}</h3>
                <p>
                  {previous.title} · {previous.folder || t("根目录")}
                </p>
                <ChatMarkdown content={previous.body} />
                <p>
                  {t("出处：")}
                  {previous.source || t("无")}
                </p>
              </section>
              <section>
                <h3>
                  {t("合并草稿 · 当前版本 ")}
                  {current.version}
                </h3>
                <div className="field">
                  <label htmlFor="merge-title">{t("合并标题")}</label>
                  <input
                    id="merge-title"
                    value={input.title}
                    onChange={(event) => setInput({ ...input, title: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="merge-folder">{t("合并目录")}</label>
                  <input
                    id="merge-folder"
                    value={input.folder}
                    onChange={(event) => setInput({ ...input, folder: event.target.value })}
                  />
                </div>
                <fieldset className="note-tag-picker">
                  <legend>{t("合并标签")}</legend>
                  {notesStore.snapshot().tags.map((tag) => (
                    <label key={tag.id}>
                      <input
                        type="checkbox"
                        checked={input.tag_ids.includes(tag.id)}
                        onChange={(event) =>
                          setInput({
                            ...input,
                            tag_ids: event.target.checked
                              ? [...input.tag_ids, tag.id]
                              : input.tag_ids.filter((id) => id !== tag.id),
                          })
                        }
                      />
                      {tag.name}
                    </label>
                  ))}
                </fieldset>
                <div className="field">
                  <label htmlFor="merge-body">{t("合并正文")}</label>
                  <textarea
                    id="merge-body"
                    rows={12}
                    value={input.body}
                    onChange={(event) => setInput({ ...input, body: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="merge-source">{t("合并出处")}</label>
                  <textarea
                    id="merge-source"
                    rows={2}
                    value={input.source}
                    onChange={(event) => setInput({ ...input, source: event.target.value })}
                  />
                </div>
              </section>
            </div>
            <label className="memory-check">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => setChecked(event.target.checked)}
              />
              {t("我已对照，使用右侧内容替换这份旧草稿")}
            </label>
            <ActionButton
              className="primary-button"
              disabled={!checked}
              onClick={() => {
                notesStore.reconcile(current, input);
                setOpen(false);
                onEdit();
              }}
            >
              {t("建立合并草稿")}
            </ActionButton>
          </>
        )}
      </Modal>
    </>
  );
}
