"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { completeWelcome, subscribeWelcome, welcomeComplete } from "@/lib/onboarding";

export function useWelcomeGuard() {
  const pathname = usePathname();
  const router = useRouter();
  const isWelcome = pathname.replace(/\/$/, "") === "/welcome";
  const completed = useSyncExternalStore(subscribeWelcome, welcomeComplete, () => false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (isWelcome || completed || unavailable || welcomeComplete()) return;
    const controller = new AbortController();
    let active = true;
    const preserveExisting = (exists: boolean) => {
      if (exists && active && !controller.signal.aborted) {
        completeWelcome();
        controller.abort();
      }
      return exists;
    };
    // Read-only checks let existing installations keep their current route.
    const reads = [
      api.agentStatus(controller.signal).then((status) => preserveExisting(status.configured)),
      api.notes(controller.signal).then((notes) => preserveExisting(notes.total > 0)),
      api
        .conversations(0, controller.signal)
        .then((conversations) => preserveExisting(conversations.total > 0)),
      api.listTags("", controller.signal).then((tags) => preserveExisting(tags.total > 0)),
    ];
    void Promise.allSettled(reads).then((results) => {
      if (!active || controller.signal.aborted || welcomeComplete()) return;
      if (results.some((result) => result.status === "rejected")) {
        // An unreachable service is not evidence of an empty installation.
        // Keep recovery and existing navigation available until a later visit.
        setUnavailable(true);
      } else router.replace("/welcome/");
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [completed, isWelcome, router, unavailable]);
  return { isWelcome, ready: isWelcome || completed || unavailable };
}
