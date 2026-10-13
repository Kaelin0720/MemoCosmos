"use client";
import { t, uiMessage, useLocale } from "@/lib/i18n";
import { ActionButton } from "@/components/motion-system";

import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { agentStore } from "@/lib/chat-store";
import { useSpace } from "./space-shell";

export function ModelSettings() {
  useLocale();
  const state = useSyncExternalStore(
    agentStore.subscribe,
    agentStore.getSnapshot,
    agentStore.getServerSnapshot,
  );
  const { notify } = useSpace();
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let current = true;
    void agentStore.refresh().then(() => {
      if (current) setReady(true);
    });
    return () => {
      current = false;
    };
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const address = (baseUrl ?? state.value?.base_url ?? "").trim();
    const name = (model ?? state.value?.model ?? "").trim();
    try {
      const url = new URL(address);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      setError(t("URL需为 http/https API 基址，不能包含账号、密码、查询参数或片段。"));
      return;
    }
    if (!name) {
      setError(t("请填写模型名称。"));
      return;
    }
    if (!apiKey && !state.value?.has_api_key) {
      setError(t("首次配置请填写 API Key。"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.saveAgentConfig({
        base_url: address,
        model: name,
        ...(apiKey ? { api_key: apiKey } : {}),
      });
      setApiKey("");
      agentStore.set(result);
      notify(t("模型配置已保存。下一次发消息时验证云端连接。"));
    } catch {
      // Config errors must never echo a submitted credential or a vendor exception.
      setError(t("配置保存未确认，请检查输入与本机连接。页面不会自动测试模型或重新提交密钥。"));
    } finally {
      setBusy(false);
    }
  }
  const unavailable = !ready || state.loading || Boolean(state.error);
  return (
    <div className="setting-section model-settings">
      <div className="setting-section-title">
        <Sparkles size={20} />
        <h2>{t("云端主智能体")}</h2>
        <span className="stage-badge">{t("OpenAI 兼容协议")}</span>
      </div>
      <p className="model-explanation">
        {t(
          "填写服务地址、模型名称与 API Key。聊天和自动整理使用云端模型，原始对话与记忆保存在本机。",
        )}
      </p>
      {(!ready || state.loading) && (
        <p role="status" className="stream-note">
          {t("正在读取模型配置…")}
        </p>
      )}
      {state.error && (
        <div className="inline-error" role="alert">
          {t("无法读取模型配置。")}
          <ActionButton className="quiet-button" onClick={() => void agentStore.refresh()}>
            {t("重新读取")}
          </ActionButton>
        </div>
      )}
      {state.value && (
        <p className="model-config-state" role="status">
          {state.value.configured ? t("配置已齐全，可在会话中验证连接") : t("云端模型尚未配置")}
          <span>
            {state.value.has_api_key
              ? t("API Key 已配置，读取不会返回密钥")
              : t("尚未配置 API Key")}
          </span>
          <span>
            {t("来源：")}
            {
              { file: t("本机配置文件"), env: t("进程环境变量"), none: t("未配置") }[
                state.value.source
              ]
            }
          </span>
          <ActionButton
            type="button"
            className="quiet-button"
            disabled={busy || !ready}
            onClick={() => void agentStore.refresh()}
          >
            {t("刷新配置状态")}
          </ActionButton>
        </p>
      )}
      <form onSubmit={(event) => void save(event)} autoComplete="off" aria-busy={busy}>
        <div className="field">
          <label htmlFor="model-url">API URL</label>
          <input
            id="model-url"
            type="url"
            required
            autoComplete="off"
            placeholder={t("你的 OpenAI 兼容 API 基址")}
            value={baseUrl ?? state.value?.base_url ?? ""}
            disabled={busy || unavailable}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <p className="field-help">
            {t("完整 API 基址，通常包含服务方提供的版本路径。云端推荐 HTTPS。")}
          </p>
        </div>
        <div className="field">
          <label htmlFor="model-name">{t("模型名称")}</label>
          <input
            id="model-name"
            required
            autoComplete="off"
            placeholder={t("填写服务方提供的模型名称")}
            value={model ?? state.value?.model ?? ""}
            disabled={busy || unavailable}
            onChange={(event) => setModel(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="model-key">
            API Key{" "}
            <span>{state.value?.has_api_key ? t("留空沿用已有密钥") : t("首次配置必填")}</span>
          </label>
          <input
            id="model-key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            disabled={busy || unavailable}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              state.value?.has_api_key ? t("已有密钥不会显示在这里") : t("仅写入，保存后清空")
            }
          />
          <p className="field-help">{t("密钥仅在当前表单暂存，不保存在浏览器存储中。")}</p>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {uiMessage(error)}
          </p>
        )}
        <ActionButton type="submit" className="primary-button" disabled={busy || unavailable}>
          {busy && <LoaderCircle size={15} className="spin" />}
          {busy ? t("正在保存…") : t("保存模型配置")}
        </ActionButton>
      </form>
    </div>
  );
}
