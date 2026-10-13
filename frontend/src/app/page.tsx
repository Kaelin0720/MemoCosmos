"use client";
import { t, useLocale } from "@/lib/i18n";
import { Suspense } from "react";
import { ChatWorkbench } from "@/components/chat-workbench";
export default function Workbench() {
  useLocale();
  return (
    <Suspense
      fallback={
        <div className="conversation-window glass-panel chat-loading" role="status">
          {t("正在打开对话空间…")}
        </div>
      }
    >
      <ChatWorkbench />
    </Suspense>
  );
}
