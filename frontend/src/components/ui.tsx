"use client";
import { t, useLocale } from "@/lib/i18n";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ActionButton, useQuietMotion } from "./motion-system";

export function BrandMark({ className = "" }: { className?: string }) {
  useLocale();
  return (
    <svg className={`brand-mark ${className}`} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path
        d="M24 2C27 17 31 21 46 24C31 27 27 31 24 46C21 31 17 27 2 24C17 21 21 17 24 2Z"
        fill="currentColor"
      />
      <path
        d="M41 2L42.8 7.2L48 9L42.8 10.8L41 16L39.2 10.8L34 9L39.2 7.2L41 2Z"
        fill="currentColor"
        opacity=".6"
      />
    </svg>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  busy = false,
  onExitComplete,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  busy?: boolean;
  onExitComplete?: () => void;
}) {
  useLocale();
  const reduced = useQuietMotion();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <Dialog.Portal forceMount>
        <AnimatePresence onExitComplete={onExitComplete}>
          {open && (
            <Dialog.Overlay key="overlay" forceMount asChild>
              <motion.div
                className="dialog-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.18 }}
              />
            </Dialog.Overlay>
          )}
          {open && (
            <Dialog.Content
              key="content"
              forceMount
              asChild
              onEscapeKeyDown={(event) => {
                if (busy) event.preventDefault();
              }}
              onInteractOutside={(event) => {
                if (busy) event.preventDefault();
              }}
            >
              <motion.div
                className="dialog-content"
                initial={reduced ? false : { opacity: 0, scale: 0.96, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: reduced ? 1 : 0.98, y: reduced ? 0 : 6 }}
                transition={
                  reduced ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 35 }
                }
              >
                <div className="dialog-heading">
                  <div>
                    <Dialog.Title className="dialog-title">{title}</Dialog.Title>
                    <Dialog.Description className="dialog-description">
                      {description}
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <ActionButton
                      className="icon-button"
                      aria-label={t("关闭对话框")}
                      disabled={busy}
                    >
                      <X size={18} />
                    </ActionButton>
                  </Dialog.Close>
                </div>
                {children}
              </motion.div>
            </Dialog.Content>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
