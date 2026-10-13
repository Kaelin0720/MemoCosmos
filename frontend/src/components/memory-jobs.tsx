"use client";
import { t, uiDate, uiMessage, useLocale } from "@/lib/i18n";
import { ActionButton } from "@/components/motion-system";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Sparkles, RefreshCw } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import type { MemoryJob } from "@/lib/memory-types";
const labels: Record<MemoryJob["status"], string> = {
  pending: "等待整理",
  running: "正在整理",
  completed: "已整理",
  skipped: "已跳过",
  needs_confirmation: "待你确认",
  failed: "整理失败",
  interrupted: "整理已中断",
};

export function MemoryJobs({
  conversationId,
  runId,
  onChanged,
}: {
  conversationId?: string;
  runId?: string;
  onChanged?: () => void;
}) {
  useLocale();
  const [items, setItems] = useState<MemoryJob[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .agentStatus(controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) setModelConfigured(status.configured);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [refresh]);
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      attempts = 0;
    let controller: AbortController | null = null;
    const seen = new Map<string, string>();
    async function read() {
      if (disposed || document.hidden || attempts >= 60) return;
      controller?.abort();
      controller = new AbortController();
      attempts++;
      try {
        const result = await api.memoryJobs(conversationId, controller.signal);
        if (disposed || controller.signal.aborted) return;
        setItems(result.items);
        setError("");
        setLoading(false);
        for (const job of result.items) {
          if (seen.get(job.id) && seen.get(job.id) !== job.updated_at && job.status === "completed")
            changed.current?.();
          seen.set(job.id, job.updated_at);
        }
        if (
          result.items.some(
            (job) =>
              job.status === "running" || (job.status === "pending" && modelConfigured !== false),
          ) ||
          (runId && attempts < 6 && !result.items.some((job) => job.run_id === runId))
        )
          timer = setTimeout(() => void read(), 2000);
      } catch (error) {
        if (!disposed && !controller.signal.aborted) {
          setError(errorMessage(error));
          setLoading(false);
        }
      }
    }
    const visible = () => {
      clearTimeout(timer);
      if (document.hidden) controller?.abort();
      else void read();
    };
    queueMicrotask(() => {
      if (!disposed) {
        setLoading(true);
        void read();
      }
    });
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [conversationId, runId, refresh, modelConfigured]);
  async function act(job: MemoryJob, action: "retry" | "confirm" | "dismiss") {
    if (busy) return;
    setBusy(job.id);
    setError("");
    try {
      const result =
        action === "retry"
          ? await api.retryMemoryJob(job.id)
          : await api.resolveMemoryJob(job.id, action, answers[job.id]);
      setItems((current) => current.map((item) => (item.id === result.id ? result : item)));
      if (result.status === "completed") changed.current?.();
      setRefresh((value) => value + 1);
    } catch (error) {
      setError(t("{0} 未自动重发操作，可重新读取当前任务核对。", [errorMessage(error)]));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section
      className={`memory-jobs ${conversationId ? "conversation-jobs" : ""}`}
      aria-label={t("知识整理")}
    >
      <header>
        <div>
          <Sparkles size={16} />
          <h2>{conversationId ? t("这次对话的知识整理") : t("最近整理与待确认")}</h2>
        </div>
        <ActionButton
          className="icon-button"
          aria-label={t("刷新整理任务")}
          onClick={() => setRefresh((value) => value + 1)}
          disabled={loading}
        >
          <RefreshCw size={14} />
        </ActionButton>
      </header>
      {loading && (
        <p className="notes-hint" role="status">
          {t("正在读取整理状态…")}
        </p>
      )}
      {error && (
        <p className="inline-error" role="status">
          {uiMessage(error)}
        </p>
      )}
      {!loading && !error && !items.length && (
        <p className="notes-hint">{t("暂无整理任务。原始聊天与知识整理分别保存。")}</p>
      )}
      <div className="memory-job-list">
        {items.map((job) => (
          <article key={job.id} className={`memory-job ${job.status}`}>
            <div className="memory-job-title">
              <strong>{t(labels[job.status])}</strong>
              <time dateTime={job.updated_at}>{uiDate(job.updated_at)}</time>
            </div>
            {job.reason && <p>{job.reason}</p>}
            {job.error && <p className="inline-error">{uiMessage(job.error.message)}</p>}
            {job.status === "completed" && (
              <div className="note-tags">
                {job.notes.map((note) => (
                  <Link key={note.id} href={`/knowledge/?note=${note.id}`}>
                    {note.action === "created" ? t("新增") : t("更新")} · {note.title}
                  </Link>
                ))}
              </div>
            )}
            {job.status === "needs_confirmation" && (
              <div className="job-confirmation">
                <p>{job.question || t("请核对这份整理建议。")}</p>
                <label htmlFor={`clarification-${job.id}`}>{t("补充澄清（选填）")}</label>
                <textarea
                  id={`clarification-${job.id}`}
                  maxLength={2000}
                  rows={2}
                  value={answers[job.id] ?? ""}
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [job.id]: event.target.value }))
                  }
                  placeholder={t("说明你想保留的含义…")}
                />
                <div className="notes-actions">
                  <ActionButton
                    className="primary-button"
                    disabled={Boolean(busy)}
                    onClick={() => void act(job, "confirm")}
                  >
                    {answers[job.id]?.trim() ? t("提交澄清") : t("确认建议")}
                  </ActionButton>
                  <ActionButton
                    className="secondary-button"
                    disabled={Boolean(busy)}
                    onClick={() => void act(job, "dismiss")}
                  >
                    {t("跳过这次整理")}
                  </ActionButton>
                </div>
              </div>
            )}
            {(["failed", "interrupted"].includes(job.status) ||
              (job.status === "pending" && modelConfigured === false)) && (
              <ActionButton
                className="secondary-button"
                disabled={Boolean(busy)}
                onClick={() => void act(job, "retry")}
              >
                {t("重新整理")}
              </ActionButton>
            )}
            {((modelConfigured === false && job.status === "pending") ||
              job.error?.code === "model_not_configured" ||
              job.reason === "model_not_configured") && (
              <Link href="/settings/" className="notes-tag-link">
                {t("配置云端模型")}
              </Link>
            )}
          </article>
        ))}
      </div>
      <p className="notes-hint">
        {t("整理使用你配置的云端模型，记忆保存在本机。")}
        <Link href="/settings/">{t("设置自动整理")}</Link>
      </p>
    </section>
  );
}
