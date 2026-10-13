"use client";
import { t, uiMessage, useLocale } from "@/lib/i18n";
import { ActionButton } from "@/components/motion-system";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { MemoryHit } from "@/lib/memory-types";
export function MemorySearch({
  tagId,
  onOpen,
}: {
  tagId?: string;
  onOpen: (id: string, heading?: string) => void;
}) {
  useLocale();
  const [query, setQuery] = useState(""),
    [items, setItems] = useState<MemoryHit[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [searched, setSearched] = useState(false),
    [truncated, setTruncated] = useState(false);
  const controller = useRef<AbortController | null>(null),
    epoch = useRef(0);
  useEffect(
    () => () => {
      controller.current?.abort();
      ++epoch.current;
    },
    [],
  );
  async function search() {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    const requestId = ++epoch.current;
    setLoading(true);
    setError("");
    setSearched(true);
    try {
      const result = await api.memorySearch(query.trim(), tagId ? [tagId] : [], next.signal);
      if (!next.signal.aborted && epoch.current === requestId) {
        setItems(result.items);
        setTruncated(result.truncated);
      }
    } catch (error) {
      if (!next.signal.aborted && epoch.current === requestId) setError(errorMessage(error));
    } finally {
      if (!next.signal.aborted && epoch.current === requestId) setLoading(false);
    }
  }
  return (
    <details className="memory-search">
      <summary>
        <Search size={15} />
        {t("章节与正文检索")}
      </summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label htmlFor="memory-query">{t("检索知识内容")}</label>
        <div className="memory-search-input">
          <input
            id="memory-query"
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("输入主题或章节关键词")}
          />
          <ActionButton className="secondary-button" disabled={loading || !query.trim()}>
            {loading ? t("检索中…") : t("检索")}
          </ActionButton>
        </div>
      </form>
      <p className="notes-hint">
        {t("本机标签与章节关键词检索，")}
        {tagId ? t("按当前标签查找。") : t("不额外调用模型。")}
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {uiMessage(error)}
        </p>
      )}
      {searched && !loading && !error && !items.length && (
        <p className="notes-hint">{t("没有找到相关章节。")}</p>
      )}
      {items.map((hit, index) => (
        <ActionButton
          className="memory-hit"
          key={`${hit.note_id}-${index}`}
          onClick={() => onOpen(hit.note_id, hit.heading)}
        >
          <strong>{hit.title}</strong>
          <span>
            {hit.heading || t("主题正文")}
            {t("· 版本 ")}
            {hit.version}
          </span>
          <p>{hit.excerpt}</p>
        </ActionButton>
      ))}
      {truncated && <p className="notes-hint">{t("结果已按摘录预算截取，请打开原文阅读。")}</p>}
    </details>
  );
}
