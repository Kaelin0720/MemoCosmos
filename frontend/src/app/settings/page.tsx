"use client";
import { t, uiMessage, useLocale } from "@/lib/i18n";
import { WorkspaceSurface } from "@/components/motion-system";
import { ActionButton } from "@/components/motion-system";

import { Suspense, useState } from "react";
import Link from "next/link";
import { Eye, LoaderCircle, Radio, Orbit, ArrowUpRight } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useSpace, ConnectionBadge } from "@/components/space-shell";
import { ModelSettings } from "@/components/model-settings";
import { MemorySettings } from "@/components/memory-settings";
import { SetupGuide } from "@/components/setup-guide";

export default function Settings() {
  useLocale();
  const { reduced, systemReduced, setReduced, notify } = useSpace();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  async function check() {
    if (checking) return;
    setChecking(true);
    setError("");
    try {
      await api.checkConnection();
      notify(t("本机服务连接正常。"));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setChecking(false);
    }
  }
  return (
    <WorkspaceSurface className="settings-page glass-panel">
      <p className="eyebrow">{t("个人空间 / 偏好")}</p>
      <h1>{t("让这个空间更适合你")}</h1>
      <p className="page-description">{t("舒适的阅读与可靠的本机连接")}</p>
      <Suspense fallback={null}>
        <SetupGuide />
      </Suspense>
      <ModelSettings />
      <MemorySettings />
      <div className="setting-section">
        <div className="setting-section-title">
          <Orbit size={20} />
          <h2>{t("欢迎与语言")}</h2>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("你的记忆宇宙")}</strong>
            <p>{t("重新选择界面语言，或再看一次欢迎引导。")}</p>
          </div>
          <Link className="secondary-button" href="/welcome/">
            {t("重看欢迎页")}
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </div>
      <div className="setting-section">
        <div className="setting-section-title">
          <Eye size={20} />
          <h2>{t("视觉与动画")}</h2>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("减少动画")}</strong>
            <p>
              {t("停止背景星点与星图光流，减少页面切换效果。")}
              <br />
              {t("同时遵循系统的减少动态效果偏好。")}
            </p>
          </div>
          <ActionButton
            type="button"
            role="switch"
            aria-checked={reduced}
            aria-label={t("减少动画")}
            className="toggle"
            disabled={systemReduced}
            onClick={() => setReduced(!reduced)}
          >
            <span />
          </ActionButton>
        </div>
        <p className="field-help">
          {systemReduced
            ? t("系统已开启减少动态效果，此处遵循系统设置。")
            : t("此偏好在本次打开期间有效。")}
        </p>
      </div>
      <div className="setting-section">
        <div className="setting-section-title">
          <Radio size={20} />
          <h2>{t("本机服务")}</h2>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("连接状态")}</strong>
            <p>{t("标签池通过本机服务保存在你的记忆库中。")}</p>
          </div>
          <ConnectionBadge />
        </div>
        <div className="field">
          <label htmlFor="api-address">{t("服务地址")}</label>
          <input id="api-address" readOnly value={api.baseUrl || t("同源地址")} />
          <p className="field-help">{t("由启动配置指定，当前页面只查看连接信息。")}</p>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {uiMessage(error)}
          </p>
        )}
        <ActionButton className="secondary-button" disabled={checking} onClick={() => void check()}>
          {checking && <LoaderCircle size={15} className="spin" />}
          {checking ? t("正在检查…") : t("检查连接")}
        </ActionButton>
      </div>
    </WorkspaceSurface>
  );
}
