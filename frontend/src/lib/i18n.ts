import { useSyncExternalStore } from "react";
import { LANGUAGE_STORAGE_KEY } from "./product";
import { english } from "./translations/en";

export type Locale = "zh-CN" | "en";
const translations = new Map(Object.entries(english));
const storageKey = LANGUAGE_STORAGE_KEY;
let locale: Locale = "zh-CN";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getLocale = () => locale;
export const useLocale = () => useSyncExternalStore(subscribe, getLocale, () => "zh-CN" as Locale);
export function setLocale(next: Locale) {
  if (next !== "en" && next !== "zh-CN") return;
  locale = next;
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    /* Preference can stay in memory. */
  }
  listeners.forEach((listener) => listener());
}
export function restoreLocale() {
  try {
    const saved =
      localStorage.getItem(storageKey) ?? localStorage.getItem("yihe.interface-language");
    if (saved === "en" || saved === "zh-CN") setLocale(saved);
  } catch {
    /* Storage is optional. */
  }
}
export function t(source: string, values: unknown[] = [], language: Locale = locale): string {
  const key = source.trim();
  const translation = language === "en" ? translations.get(key) : undefined;
  const result = translation ? source.replace(key, translation) : source;
  // Interpolated titles, tag names and other user data keep their original text.
  return result.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : match,
  );
}
export function uiDate(
  value: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
) {
  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
}

function templatePattern(source: string) {
  const indexes: number[] = [];
  const pattern = source
    .split(/(\{\d+\})/)
    .map((part) => {
      if (/\{\d+\}/.test(part)) {
        indexes.push(Number(part.slice(1, -1)));
        return "(.*?)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return { regex: new RegExp(`^${pattern}$`, "s"), indexes };
}
const messageTemplates = [...translations]
  .filter(([source]) => /\{\d+\}/.test(source))
  .map(([source, translation]) => ({
    source,
    translation,
    chinese: templatePattern(source),
    english: templatePattern(translation),
  }));
const chinese = new Map([...translations].map(([source, translation]) => [translation, source]));

// Only UI-owned messages use this function. Knowledge, tags, evidence and chat
// content are user data and must never be translated by the interface preference.
export function uiMessage(message: string, language: Locale = locale, depth = 0): string {
  const direct = language === "en" ? translations.get(message.trim()) : chinese.get(message.trim());
  if (direct) return direct;
  if (depth < 3)
    for (const entry of messageTemplates) {
      const { regex, indexes } = language === "en" ? entry.chinese : entry.english;
      const match = regex.exec(message);
      if (!match) continue;
      const values: Record<number, string> = {};
      indexes.forEach((index, i) => {
        // Quoted names belong to the user; nested error descriptions belong to UI.
        values[index] = entry.source.includes("「")
          ? match[i + 1]
          : uiMessage(match[i + 1], language, depth + 1);
      });
      return (language === "en" ? entry.translation : entry.source).replace(
        /\{(\d+)\}/g,
        (_, index: string) => values[Number(index)] ?? "",
      );
    }
  // Preserve unknown provider/service diagnostics instead of discarding details.
  return message;
}
