"use client";
import { t, useLocale } from "@/lib/i18n";

import { Children, isValidElement, useDeferredValue, type ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { isNoteId } from "@/lib/note-types";

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : "",
    )
    .join("");
}
function safeUrl(url: string): string | undefined {
  const internal = noteUrl(url);
  if (internal) return internal;
  if (/[\u0000-\u0020\u007f]/.test(url) || !/^https?:\/\//i.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return undefined;
    return defaultUrlTransform(url);
  } catch {
    return undefined;
  }
}

export function headingId(title: string) {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}
function noteUrl(url: string) {
  const match = /^(?:\.\/|yihe:\/\/notes\/)([\da-f-]+)(?:\.md)?(?:#([^\s]+))?$/i.exec(url);
  if (!match || !isNoteId(match[1])) return undefined;
  return `/knowledge/?note=${match[1].toLowerCase()}${match[2] ? `#${encodeURIComponent(match[2])}` : ""}`;
}
export function ChatMarkdown({
  content,
  onNoteLink,
}: {
  content: string;
  onNoteLink?: (id: string) => void;
}) {
  useLocale();
  const deferred = useDeferredValue(content);
  return (
    <div className="chat-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          a: ({ href, children }) => {
            const title = textOf(children).replace(/^\s*#+\s*/, "") || t("关联内容");
            return href?.startsWith("/knowledge/?note=") ? (
              <Link
                href={href}
                onClick={
                  onNoteLink
                    ? (event) => {
                        event.preventDefault();
                        const id = new URL(href, window.location.origin).searchParams.get("note");
                        if (id) onNoteLink(id);
                      }
                    : undefined
                }
              >
                {title}
              </Link>
            ) : href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {title}
              </a>
            ) : (
              <span
                className="unavailable-link"
                title={t("链接地址不受支持，或未提供有效的文档 ID")}
              >
                {title}
              </span>
            );
          },
          h1: ({ children }) => <h1 id={headingId(textOf(children))}>{children}</h1>,
          h2: ({ children }) => <h2 id={headingId(textOf(children))}>{children}</h2>,
          h3: ({ children }) => <h3 id={headingId(textOf(children))}>{children}</h3>,
          h4: ({ children }) => <h4 id={headingId(textOf(children))}>{children}</h4>,
          h5: ({ children }) => <h5 id={headingId(textOf(children))}>{children}</h5>,
          h6: ({ children }) => <h6 id={headingId(textOf(children))}>{children}</h6>,
          img: ({ alt }) => (
            <span className="image-placeholder">
              {alt ? t("图片：{0}", [alt]) : t("图片")}
              {t("（图片内容无法在此显示）")}
            </span>
          ),
          table: ({ children }) => (
            <div className="markdown-table-wrap" tabIndex={0} aria-label={t("表格，可横向滚动")}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {deferred}
      </Markdown>
    </div>
  );
}
