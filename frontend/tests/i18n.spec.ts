import { test, expect } from "./test";
import { setLocale, t, uiDate, uiMessage } from "../src/lib/i18n";

test("界面提示可双向切换，引用的中文名称与未知服务详情完整保留", () => {
  expect(t("选择节点 {0}", ["停止"], "en")).toBe("Select node 停止");
  const saved = uiMessage("已保存「停止」。", "en");
  expect(saved).toBe("Saved “停止”.");
  expect(uiMessage(saved, "zh-CN")).toBe("已保存「停止」。");
  const failed = uiMessage(
    "保存结果未确认。无法连接本机服务，请确认后端已启动，然后重试。 草稿已保留，请读取目录或原文核对。",
    "en",
  );
  expect(failed).toContain("Cannot reach the local service");
  expect(failed).toContain("Your draft is retained");
  expect(failed).not.toMatch(/[\u3400-\u9fff]/);
  expect(uiMessage("provider_code_42: 额外诊断详情", "en")).toBe("provider_code_42: 额外诊断详情");
});

test("日期使用选择的界面语言并保留本机时区", () => {
  const date = "2026-10-10T04:00:00Z";
  try {
    for (const locale of ["en", "zh-CN"] as const) {
      setLocale(locale);
      expect(uiDate(date)).toBe(
        new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(date),
        ),
      );
    }
  } finally {
    setLocale("zh-CN");
  }
});
