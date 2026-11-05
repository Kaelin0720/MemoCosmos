import { useSyncExternalStore } from "react";
import type { CelestialStyle } from "./celestial-materials";

type Preferences = { view: "3d" | "2d"; styles: Record<string, CelestialStyle> };
const defaults: Preferences = { view: "3d", styles: {} };
let current = defaults,
  initialized = false;
const listeners = new Set<() => void>();
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem("memocosmos.celestial-styles") ?? "{}");
    const entries =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? Object.entries(raw)
            .filter(
              ([, value]) =>
                value &&
                typeof value === "object" &&
                "surface" in value &&
                typeof value.surface === "string",
            )
            .slice(0, 500)
        : [];
    current = {
      view: localStorage.getItem("memocosmos.graph-view") === "2d" ? "2d" : "3d",
      styles: Object.fromEntries(entries) as Record<string, CelestialStyle>,
    };
  } catch {
    current = defaults;
  }
}
function snapshot() {
  if (!initialized && typeof window !== "undefined") {
    load();
    initialized = true;
  }
  return current;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const update = (event: StorageEvent) => {
    if (event.key?.startsWith("memocosmos.")) {
      load();
      listeners.forEach((fn) => fn());
    }
  };
  window.addEventListener("storage", update);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", update);
  };
}
function save(next: Preferences) {
  current = next;
  try {
    localStorage.setItem("memocosmos.graph-view", next.view);
    localStorage.setItem("memocosmos.celestial-styles", JSON.stringify(next.styles));
  } catch {
    /* Preferences can remain in memory. */
  }
  listeners.forEach((fn) => fn());
}
export function useUniversePreferences() {
  const value = useSyncExternalStore(subscribe, snapshot, () => defaults);
  return {
    ...value,
    changeView: (view: "3d" | "2d") => save({ ...current, view }),
    changeStyle: (id: string, style: CelestialStyle) =>
      save({ ...current, styles: { ...current.styles, [id]: style } }),
  };
}
