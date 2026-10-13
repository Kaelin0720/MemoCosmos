"use client";
import { t, uiMessage, useLocale } from "@/lib/i18n";
import { ActionButton } from "@/components/motion-system";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { usePresence } from "motion/react";
import { api, ApiError, errorMessage, type Tag } from "@/lib/api";
import { Modal } from "./ui";

export function TagEditor({
  tag,
  onClose,
  onSaved,
}: {
  tag: Tag | null;
  onClose: () => void;
  onSaved: (tag: Tag) => void;
}) {
  useLocale();
  const [present, safeToRemove] = usePresence();
  const [name, setName] = useState(tag?.name ?? "");
  const [description, setDescription] = useState(tag?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (nameError && !busy) nameInput.current?.focus();
  }, [nameError, busy]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError(t("请输入标签名称。"));
      setNameError(true);
      nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    setNameError(false);
    try {
      const input = { name: name.trim(), description };
      const saved = tag ? await api.updateTag(tag.id, input) : await api.createTag(input);
      onSaved(saved);
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && error.code === "duplicate_tag") {
        setNameError(true);
        nameInput.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={present}
      onExitComplete={() => safeToRemove?.()}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      busy={busy}
      title={tag ? t("编辑标签") : t("新增标签")}
      description={t("给知识一个清晰的名字，方便日后找到它。")}
    >
      <form onSubmit={(event) => void submit(event)} className="tag-form" aria-busy={busy}>
        <div className="field">
          <label htmlFor="tag-name">
            {t("标签名称 ")}
            <span>{t("必填")}</span>
          </label>
          <input
            ref={nameInput}
            id="tag-name"
            name="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(false);
            }}
            maxLength={80}
            required
            disabled={busy}
            autoComplete="off"
            placeholder={t("例如：RAG、阅读、项目复盘")}
            aria-invalid={nameError}
            aria-describedby={nameError ? "tag-form-error tag-name-help" : "tag-name-help"}
          />
          <p id="tag-name-help" className="field-help">
            {t("最多 80 个字符，名称不区分大小写。")}
          </p>
        </div>
        <div className="field">
          <label htmlFor="tag-description">
            {t("描述 ")}
            <span>{t("选填")}</span>
          </label>
          <textarea
            id="tag-description"
            name="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={1000}
            disabled={busy}
            placeholder={t("这个标签用来收录什么？")}
            rows={4}
            aria-describedby="tag-description-help"
          />
          <p id="tag-description-help" className="field-help character-count">
            {description.length} / 1000
          </p>
        </div>
        {error && (
          <p id="tag-form-error" className="inline-error" role="alert">
            {uiMessage(error)}
          </p>
        )}
        <div className="dialog-footer">
          <ActionButton
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={busy}
          >
            {t("取消")}
          </ActionButton>
          <ActionButton type="submit" className="primary-button" disabled={busy || !name.trim()}>
            {busy && <LoaderCircle size={16} className="spin" />}
            {busy ? t("正在保存…") : t("保存标签")}
          </ActionButton>
        </div>
      </form>
    </Modal>
  );
}
