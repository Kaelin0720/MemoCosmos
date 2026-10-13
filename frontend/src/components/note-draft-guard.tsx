"use client";
import { useEffect, useSyncExternalStore } from "react";
import { notesStore } from "@/lib/notes-store";
export function NoteDraftGuard() {
  const state = useSyncExternalStore(
    notesStore.subscribe,
    notesStore.snapshot,
    notesStore.serverSnapshot,
  );
  const dirty = state.hasDrafts;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return null;
}
