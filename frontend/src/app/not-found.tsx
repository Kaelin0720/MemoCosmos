"use client";
import { t, useLocale } from "@/lib/i18n";
import Link from "next/link";
export default function NotFound() {
  useLocale();
  return (
    <section className="placeholder-page glass-panel">
      <p className="eyebrow">{t("迷失在星图之外")}</p>
      <h1>{t("这个空间还不存在。")}</h1>
      <p className="placeholder-description">{t("返回工作台，继续整理你的记忆。")}</p>
      <Link href="/" className="secondary-button">
        {t("回到工作台")}
      </Link>
    </section>
  );
}
