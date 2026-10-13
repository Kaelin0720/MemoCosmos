"use client";
import { t, uiDate, uiMessage, useLocale } from "@/lib/i18n";
import { AnimatePresence, motion } from "motion/react";
import { WorkspaceSurface } from "@/components/motion-system";
import { ActionButton } from "@/components/motion-system";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  CircleAlert,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tags,
  Star,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { api, errorMessage, type Tag } from "@/lib/api";
import { useSpace } from "@/components/space-shell";
import { TagEditor } from "@/components/tag-editor";

function formatDate(value: string) {
  return uiDate(value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function TagPool() {
  useLocale();
  const { notify } = useSpace();
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Tag[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ tag: Tag | null } | null>(null);
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => {
        setLoading(true);
        setError("");
        void api
          .listTags(query, controller.signal)
          .then((result) => {
            if (!controller.signal.aborted) {
              setItems(result.items);
              setTotal(result.total);
            }
          })
          .catch((error) => {
            if (!controller.signal.aborted) setError(errorMessage(error));
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query, revision]);

  function refresh() {
    setLoading(true);
    setRevision((value) => value + 1);
  }
  async function confirmDelete() {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api.deleteTag(deleting.id);
      setDeleting(null);
      notify(t("标签已删除。"));
      refresh();
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <WorkspaceSurface className="collection-page glass-panel" aria-labelledby="tags-title">
      <div className="collection-heading">
        <div>
          <p className="eyebrow">{t("个人记忆库 / 分类")}</p>
          <h1 id="tags-title">
            {t("标签池")}
            <Star className="heading-star" size={22} aria-hidden="true" />
          </h1>
          <p>{t("为知识与经历留下一条线索")}</p>
        </div>
        <ActionButton className="primary-button" onClick={() => setEditor({ tag: null })}>
          <Plus size={17} />
          {t("新增标签")}
        </ActionButton>
      </div>
      <div className="collection-toolbar">
        <div className="tag-search">
          <Search size={17} />
          <label htmlFor="tag-query" className="sr-only">
            {t("搜索标签")}
          </label>
          <input
            id="tag-query"
            type="search"
            placeholder={t("搜索名称或描述…")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLoading(true);
            }}
          />
          {query && (
            <ActionButton
              className="icon-button"
              aria-label={t("清空搜索")}
              onClick={() => {
                setQuery("");
                setLoading(true);
              }}
            >
              <X size={15} />
            </ActionButton>
          )}
        </div>
        <div className="collection-meta">
          <span>
            {loading
              ? t("正在读取…")
              : error
                ? t("读取未完成")
                : query.trim()
                  ? t("{0} 个匹配的标签", [total])
                  : t("{0} 个标签", [total])}
          </span>
          <ActionButton
            className="icon-button"
            aria-label={t("刷新标签列表")}
            disabled={loading}
            onClick={refresh}
          >
            <RefreshCw size={16} className={loading ? "spin" : ""} />
          </ActionButton>
        </div>
      </div>
      <div className="tag-list-region" aria-busy={loading}>
        {loading ? (
          <div className="list-state" role="status">
            <LoaderCircle size={27} className="spin" />
            <h2>{t("正在读取标签池")}</h2>
            <p>{t("正在向本机服务获取最新数据。")}</p>
          </div>
        ) : error ? (
          <div className="list-state error-state" role="alert">
            <CircleAlert size={31} />
            <h2>{t("暂时无法读取标签")}</h2>
            <p>{uiMessage(error)}</p>
            <ActionButton className="secondary-button" onClick={refresh}>
              <RefreshCw size={15} />
              {t("重新加载")}
            </ActionButton>
          </div>
        ) : items.length === 0 ? (
          <div className="list-state">
            <span className="empty-symbol">
              <Tags size={28} />
            </span>
            <h2>{query.trim() ? t("没有找到匹配的标签") : t("你的第一颗记忆星点")}</h2>
            <p>
              {query.trim()
                ? t("试试其他名称，或搜索描述中的关键词。")
                : t("标签池还是空的，先为未来的知识建立一个分类。")}
            </p>
            {query.trim() ? (
              <ActionButton
                className="secondary-button"
                onClick={() => {
                  setQuery("");
                  setLoading(true);
                }}
              >
                {t("清空搜索")}
              </ActionButton>
            ) : (
              <ActionButton className="secondary-button" onClick={() => setEditor({ tag: null })}>
                <Plus size={16} />
                {t("新增第一个标签")}
              </ActionButton>
            )}
          </div>
        ) : (
          <table className="tag-table">
            <caption className="sr-only">
              {t("本机标签池，")}
              {total}
              {t("个标签")}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("名称与描述")}</th>
                <th scope="col">{t("创建来源")}</th>
                <th scope="col">{t("最近更新")}</th>
                <th scope="col">
                  <span className="sr-only">{t("操作")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {items.map((tag) => (
                  <motion.tr
                    layout
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    key={tag.id}
                  >
                    <td>
                      <div className="tag-name-cell">
                        <Star className="tag-star" size={15} aria-hidden="true" />
                        <div>
                          <strong>{tag.name}</strong>
                          <p>{tag.description || t("暂无描述")}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`origin-badge ${tag.created_by}`}>
                        {tag.created_by === "user" ? t("我创建的") : t("AI 创建")}
                      </span>
                    </td>
                    <td>
                      <time dateTime={tag.updated_at}>{formatDate(tag.updated_at)}</time>
                    </td>
                    <td>
                      <Dropdown.Root>
                        <Dropdown.Trigger
                          className="icon-button"
                          aria-label={t("操作标签 {0}", [tag.name])}
                        >
                          <MoreHorizontal size={19} />
                        </Dropdown.Trigger>
                        <Dropdown.Portal>
                          <Dropdown.Content
                            className="space-menu row-menu"
                            align="end"
                            sideOffset={6}
                          >
                            <Dropdown.Item onSelect={() => setEditor({ tag })}>
                              <Pencil size={15} />
                              {t("编辑标签")}
                            </Dropdown.Item>
                            <Dropdown.Item
                              className="danger-item"
                              onSelect={() => {
                                setDeleting(tag);
                                setDeleteError("");
                              }}
                            >
                              <Trash2 size={15} />
                              {t("删除标签")}
                            </Dropdown.Item>
                          </Dropdown.Content>
                        </Dropdown.Portal>
                      </Dropdown.Root>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        )}
      </div>
      <div className="collection-footnote">
        <span>{t("保存在本机记忆库 · 页面数据以服务响应为准")}</span>
        <Link href="/knowledge/">
          {t("知识宇宙 ")}
          <ArrowUpRight size={13} />
        </Link>
      </div>
      <AnimatePresence>
        {editor && (
          <TagEditor
            key={editor.tag?.id ?? "new"}
            tag={editor.tag}
            onClose={() => setEditor(null)}
            onSaved={() => {
              notify(editor.tag ? t("标签已更新。") : t("标签已保存到本机记忆库。"));
              setEditor(null);
              refresh();
            }}
          />
        )}
      </AnimatePresence>
      <AlertDialog.Root
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="dialog-overlay" />
          <AlertDialog.Content
            className="dialog-content delete-dialog"
            onEscapeKeyDown={(event) => {
              if (deleteBusy) event.preventDefault();
            }}
          >
            <span className="delete-symbol">
              <Trash2 size={23} />
            </span>
            <AlertDialog.Title className="dialog-title">{t("删除标签？")}</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              {t("将移除“")}
              {deleting?.name}
              {t("”以及它与笔记的关联，笔记正文仍会保留。")}
            </AlertDialog.Description>
            {deleteError && (
              <p className="inline-error" role="alert">
                {deleteError}
              </p>
            )}
            <div className="dialog-footer">
              <AlertDialog.Cancel className="secondary-button" disabled={deleteBusy}>
                {t("保留标签")}
              </AlertDialog.Cancel>
              <ActionButton
                className="danger-button"
                onClick={() => void confirmDelete()}
                disabled={deleteBusy}
              >
                {deleteBusy && <LoaderCircle className="spin" size={16} />}
                {deleteBusy ? t("正在删除…") : t("确认删除")}
              </ActionButton>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </WorkspaceSurface>
  );
}
