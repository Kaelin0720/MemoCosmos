"use client";
import { PRODUCT_SLUG } from "@/lib/product";
import { t, uiMessage, useLocale } from "@/lib/i18n";
import { ActionButton } from "@/components/motion-system";
import { useEffect, useRef, useState } from "react";
import { Archive, Sparkles, Upload, Download } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { Modal } from "./ui";
export function MemorySettings() {
  useLocale();
  const [enabled, setEnabled] = useState<boolean | null>(null),
    [busy, setBusy] = useState<"setting" | "export" | "import" | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [confirm, setConfirm] = useState(false),
    [restored, setRestored] = useState<{ memory_dir: string; message: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  async function read(signal?: AbortSignal) {
    const current = ++epoch.current;
    try {
      const settings = await api.memorySettings(signal);
      if (!signal?.aborted && current === epoch.current) {
        setEnabled(settings.auto_memory);
        setError("");
      }
    } catch (error) {
      if (!signal?.aborted && current === epoch.current) setError(errorMessage(error));
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void read(controller.signal);
    });
    return () => {
      controller.abort();
    };
  }, []);
  async function toggle() {
    if (enabled === null || busy) return;
    ++epoch.current;
    setBusy("setting");
    setError("");
    setNotice("");
    try {
      const result = await api.setAutoMemory(!enabled);
      setEnabled(result.auto_memory);
      setNotice(
        result.auto_memory ? t("已开启后续对话的自动整理。") : t("已关闭后续对话的自动整理。"),
      );
    } catch (error) {
      setError(t("{0} 请重新读取设置核对。", [errorMessage(error)]));
    } finally {
      setBusy(null);
    }
  }
  async function exportZip() {
    if (busy) return;
    setBusy("export");
    setError("");
    setNotice("");
    try {
      const blob = await api.exportMemory();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${PRODUCT_SLUG}-memory-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setNotice(t("记忆包已生成并开始下载；包含可直接阅读的 Markdown，不含模型配置与密钥。"));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  async function importZip() {
    if (!file || busy) return;
    setBusy("import");
    setError("");
    setNotice("");
    try {
      const result = await api.importMemory(file);
      setRestored(result);
      setConfirm(false);
      setFile(null);
      if (input.current) input.current.value = "";
    } catch (error) {
      setError(
        t("{0} 当前记忆库保持打开，恢复结果未确认时请核对后再操作。", [errorMessage(error)]),
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <div className="setting-section">
        <div className="setting-section-title">
          <Sparkles size={20} />
          <h2>{t("自动整理")}</h2>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("成功聊天后整理新增内容")}</strong>
            <p>
              {t("开启后会额外使用你配置的云端模型，记忆仍保存在本机。")}
              <br />
              {t("本地标签与章节检索不调用云端模型。")}
            </p>
          </div>
          <ActionButton
            role="switch"
            aria-label={t("自动整理")}
            aria-checked={Boolean(enabled)}
            className="toggle"
            disabled={enabled === null || Boolean(busy)}
            onClick={() => void toggle()}
          >
            <span />
          </ActionButton>
        </div>
        <ActionButton className="text-button" disabled={Boolean(busy)} onClick={() => void read()}>
          {t("重新读取整理设置")}
        </ActionButton>
      </div>
      <div className="setting-section memory-backup">
        <div className="setting-section-title">
          <Archive size={20} />
          <h2>{t("记忆包与恢复")}</h2>
        </div>
        <p className="notes-hint">
          {t("导出标签、文档、版本、关系与原始聊天。恢复会建立新的独立记忆库，不覆盖当前库。")}
        </p>
        <div className="notes-actions">
          <ActionButton
            className="secondary-button"
            disabled={Boolean(busy)}
            onClick={() => void exportZip()}
          >
            <Download size={15} />
            {busy === "export" ? t("正在准备记忆包…") : t("导出记忆 ZIP")}
          </ActionButton>
          <label className="secondary-button" htmlFor="memory-zip">
            <Upload size={15} />
            {t("选择恢复包")}
          </label>
          <input
            className="sr-only"
            ref={input}
            id="memory-zip"
            type="file"
            accept=".zip,application/zip"
            disabled={Boolean(busy)}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError("");
              setRestored(null);
              setNotice("");
            }}
          />
        </div>
        {file && (
          <div className="memory-selected-file">
            <span>
              {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MiB
            </span>
            <ActionButton
              className="primary-button"
              disabled={Boolean(busy) || file.size > 100 * 1024 * 1024 || !file.size}
              onClick={() => setConfirm(true)}
            >
              {t("恢复到新库")}
            </ActionButton>
            {file.size > 100 * 1024 * 1024 && (
              <p className="inline-error">{t("记忆包不能超过 100 MiB。")}</p>
            )}
          </div>
        )}
        {restored && (
          <div className="memory-restored" role="status">
            <strong>{t("已恢复到新目录，需重新启动")}</strong>
            <p>{uiMessage(restored.message)}</p>
            <p>{t("恢复目录：")}</p>
            <code>{restored.memory_dir}</code>
            <p>{t("当前页面仍使用原来的记忆库。关闭当前启动器后，以新目录启动：")}</p>
            <code>{t("python run.py --memory-dir <恢复目录>")}</code>
            <p className="notes-hint">
              {t("请将上方目录作为完整参数传入；页面不会执行命令或自动切库。")}
            </p>
          </div>
        )}
      </div>
      {error && (
        <p className="inline-error memory-setting-error" role="status">
          {uiMessage(error)}
        </p>
      )}
      {notice && (
        <p className="notes-hint" role="status">
          {notice}
        </p>
      )}
      <Modal
        open={confirm}
        onOpenChange={setConfirm}
        busy={busy === "import"}
        title={t("恢复到独立的新记忆库？")}
        description={t("当前库不会被覆盖。恢复成功后需要重启，并用新目录打开。")}
      >
        <p>{file?.name}</p>
        {error && (
          <p className="inline-error" role="alert">
            {uiMessage(error)}
          </p>
        )}
        <div className="notes-actions">
          <ActionButton
            className="secondary-button"
            disabled={busy === "import"}
            onClick={() => setConfirm(false)}
          >
            {t("取消")}
          </ActionButton>
          <ActionButton
            className="primary-button"
            disabled={Boolean(busy)}
            onClick={() => void importZip()}
          >
            {busy === "import" ? t("正在验证并恢复…") : t("确认恢复到新库")}
          </ActionButton>
        </div>
      </Modal>
    </>
  );
}
