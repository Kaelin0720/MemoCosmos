"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { t, useLocale } from "@/lib/i18n";

export function SetupGuide() {
  useLocale();
  const params = useSearchParams();
  if (params.get("setup") !== "1") return null;
  return (
    <section className="setup-guide" aria-label={t("开始使用")}>
      <p className="eyebrow">{t("准备你的空间")}</p>
      <h2>{t("接下来，选择云端模型")}</h2>
      <p>{t("配置后即可对话与自动整理。你也可以先创建、阅读和连接文档，稍后再回来配置。")}</p>
      <div>
        <Link className="secondary-button" href="/knowledge/">
          {t("先进入知识库")}
          <ArrowRight size={15} aria-hidden="true" />
        </Link>
        <Link className="text-button" href="/">
          {t("打开工作台")}
        </Link>
      </div>
    </section>
  );
}
