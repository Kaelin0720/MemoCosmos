"use client";
import { t, useLocale } from "@/lib/i18n";
import { Suspense } from "react";
import { NotesWorkspace } from "@/components/notes-workspace";

export default function Knowledge() {
  useLocale();
  return (
    <Suspense
      fallback={
        <section className="glass-panel notes-workspace">
          <p>{t("正在打开主题文档…")}</p>
        </section>
      }
    >
      <NotesWorkspace />
    </Suspense>
  );
}
