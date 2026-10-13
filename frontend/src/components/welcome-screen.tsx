"use client";
import { useState, useId } from "react";
import { ArrowRight, Check, Eye, Orbit } from "lucide-react";
import { useRouter } from "next/navigation";
import { setLocale, t, useLocale } from "@/lib/i18n";
import { completeWelcome } from "@/lib/onboarding";
import { PRODUCT_NAME, PRODUCT_VERSION } from "@/lib/product";
import { ActionButton } from "./motion-system";
import { BrandMark } from "./ui";
import { useSpace } from "./space-shell";

const stars = [
  [88, 244],
  [194, 125],
  [292, 248],
  [400, 159],
  [499, 280],
  [572, 117],
  [604, 365],
  [369, 392],
  [181, 379],
];
const connections = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3],
  [2, 4],
  [2, 7],
  [3, 5],
  [4, 5],
  [4, 6],
  [4, 7],
  [7, 8],
  [0, 8],
];
export function WelcomeScreen() {
  const locale = useLocale(),
    router = useRouter();
  const { reduced, systemReduced, setReduced } = useSpace();
  const [leaving, setLeaving] = useState(false);
  const paintId = `welcome-${useId().replace(/:/g, "")}`;
  function enter(path: string) {
    if (leaving) return;
    setLeaving(true);
    completeWelcome();
    // Let the synchronous preference update finish before the route transition.
    setTimeout(() => router.replace(path), 0);
  }
  return (
    <section className="welcome-screen" aria-labelledby="welcome-heading">
      <header className="welcome-topbar">
        <div className="welcome-brand">
          <BrandMark />
          <span>{PRODUCT_NAME}</span>
        </div>
        <span className="welcome-version">{PRODUCT_VERSION}</span>
      </header>
      <div className="welcome-layout">
        <div className="welcome-copy">
          <p className="eyebrow">{t("属于你的第二大脑")}</p>
          <h1 id="welcome-heading">{t("欢迎建造你的记忆宇宙")}</h1>
          <p className="welcome-subtitle" lang={locale === "en" ? "zh-CN" : "en"}>
            {locale === "en" ? "欢迎建造你的记忆宇宙" : "Welcome to your memory universe"}
          </p>
          <p className="welcome-description">
            {t("从一次对话、一篇文档开始，让知识与经历在这里连接。")}
          </p>
          <fieldset className="welcome-language">
            <legend>{t("选择你的界面语言")}</legend>
            <div className="welcome-language-options">
              {(
                [
                  { id: "zh-CN", name: "简体中文", preview: "记录、连接与回顾" },
                  { id: "en", name: "English", preview: "Remember, connect, revisit" },
                ] as const
              ).map((option) => (
                <ActionButton
                  key={option.id}
                  type="button"
                  className="welcome-language-choice"
                  aria-label={option.name}
                  aria-pressed={locale === option.id}
                  onClick={() => setLocale(option.id)}
                  disabled={leaving}
                  lang={option.id}
                >
                  <strong>{option.name}</strong>
                  <small>{option.preview}</small>
                  {locale === option.id && <Check size={16} aria-hidden="true" />}
                </ActionButton>
              ))}
            </div>
          </fieldset>
          <div className="welcome-actions">
            <ActionButton
              className="primary-button"
              disabled={leaving}
              onClick={() => enter("/settings/?setup=1")}
            >
              {t("开始建造")}
              <ArrowRight size={17} aria-hidden="true" />
            </ActionButton>
            <ActionButton
              className="welcome-skip"
              disabled={leaving}
              onClick={() => enter("/knowledge/")}
            >
              {t("先进入知识库")}
            </ActionButton>
          </div>
          <p className="welcome-help">{t("聊天和自动整理需要配置云端模型；知识库可以先使用。")}</p>
        </div>
        <div className="welcome-visual">
          <svg
            className="welcome-sky"
            viewBox="0 0 700 500"
            aria-hidden="true"
            pointerEvents="none"
          >
            <defs>
              <radialGradient id={paintId}>
                <stop stopColor="#e9f6ff" stopOpacity=".75" />
                <stop offset=".24" stopColor="#96c8ff" stopOpacity=".26" />
                <stop offset="1" stopColor="#719deb" stopOpacity="0" />
              </radialGradient>
            </defs>
            <ellipse cx="354" cy="267" rx="250" ry="200" className="welcome-orbit" />
            <ellipse cx="354" cy="267" rx="311" ry="239" className="welcome-orbit" />
            {connections.map(([from, to], i) => (
              <line
                key={i}
                x1={stars[from][0]}
                y1={stars[from][1]}
                x2={stars[to][0]}
                y2={stars[to][1]}
                className="welcome-connection"
              />
            ))}
            {stars.map(([x, y], i) => (
              <g key={i} transform={`translate(${x},${y})`}>
                <circle r={i === 2 ? 50 : 27} fill={`url(#${paintId})`} />
                <path
                  d="M0 -15L.8 -.8L12 0L.8 .8L0 15L-.8 .8L-12 0L-.8 -.8Z"
                  fill="#d9edff"
                  opacity={i === 2 ? 0.85 : 0.35}
                />
                <circle r={i === 2 ? 5 : 2.5} fill="#f5fbff" />
              </g>
            ))}
            {Array.from({ length: 48 }, (_, i) => (
              <circle
                key={`field-${i}`}
                cx={(i * 137.5 + 31) % 700}
                cy={(i * 93.7 + 17) % 500}
                r={i % 7 === 0 ? 1.1 : 0.6}
                fill="#c2dbff"
                opacity={0.16 + (i % 4) * 0.09}
              />
            ))}
          </svg>
          <div className="welcome-visual-caption">
            <Orbit size={16} aria-hidden="true" />
            <span>{t("让每一段经历，都找到它的联系。")}</span>
          </div>
        </div>
      </div>
      <footer className="welcome-footer">
        <span>{t("记忆保存在本机 · 由你掌控")}</span>
        <ActionButton
          className="welcome-motion"
          role="switch"
          aria-checked={reduced}
          aria-label={t("减少动画")}
          disabled={systemReduced}
          onClick={() => setReduced(!reduced)}
        >
          <Eye size={15} aria-hidden="true" />
          {t("减少动画")}
          {reduced && <Check size={13} aria-hidden="true" />}
        </ActionButton>
      </footer>
    </section>
  );
}
