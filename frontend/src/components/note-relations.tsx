"use client";
import { t, useLocale } from "@/lib/i18n";
import Link from "next/link";
import type { MemoryGraph } from "@/lib/memory-types";
export function NoteRelations({
  id,
  graph,
  error,
  onOpen,
}: {
  id: string;
  graph: MemoryGraph | null;
  error: string;
  onOpen: (id: string) => void;
}) {
  useLocale();
  const relations = graph?.edges.filter((edge) => edge.source === id || edge.target === id) ?? [];
  const seen = new Set<string>();
  return (
    <div className="note-relations">
      <h3>{t("关联文档")}</h3>
      {error ? (
        <p className="notes-hint">{t("关联暂时无法读取")}</p>
      ) : !graph ? (
        <p className="notes-hint">{t("正在读取关联")}</p>
      ) : !relations.length ? (
        <p className="notes-hint">{t("暂无关联文档")}</p>
      ) : (
        <ul>
          {relations.flatMap((edge) => {
            const target = edge.source === id ? edge.target : edge.source;
            if (seen.has(target)) return [];
            seen.add(target);
            const note = graph.nodes.find((node) => node.id === target);
            return [
              <li key={target}>
                <Link
                  href={`/knowledge/?note=${target}`}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onOpen(target);
                  }}
                >
                  {note?.title ?? t("关联文档")}
                </Link>
                <small>{edge.relation}</small>
              </li>,
            ];
          })}
        </ul>
      )}
    </div>
  );
}
