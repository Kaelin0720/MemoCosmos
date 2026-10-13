"use client";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check, Languages } from "lucide-react";
import { setLocale, t, useLocale } from "@/lib/i18n";

export function LanguageMenu() {
  const locale = useLocale();
  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        className="language-trigger"
        aria-label={t("切换语言")}
        title={t("切换语言")}
      >
        <Languages size={16} />
        <span>{locale === "en" ? "EN" : "中文"}</span>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="space-menu language-menu" align="end" sideOffset={10}>
          <Dropdown.Label className="menu-label">{t("界面语言")}</Dropdown.Label>
          {(
            [
              { id: "zh-CN", label: "简体中文" },
              { id: "en", label: "English" },
            ] as const
          ).map((option) => (
            <Dropdown.Item key={option.id} onSelect={() => setLocale(option.id)}>
              <span>{option.label}</span>
              {locale === option.id && <Check size={15} />}
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
