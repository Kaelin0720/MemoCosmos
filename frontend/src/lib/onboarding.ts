import { ONBOARDING_STORAGE_KEY } from "./product";

let completed = false;
const listeners = new Set<() => void>();
export function welcomeComplete() {
  if (completed) return true;
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === "complete";
  } catch {
    return false;
  }
}
export function completeWelcome() {
  completed = true;
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "complete");
  } catch {
    // A browser that blocks storage can still continue in this session.
  }
  listeners.forEach((listener) => listener());
}
export function subscribeWelcome(listener: () => void) {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key === ONBOARDING_STORAGE_KEY || event.key === null) {
      completed = false;
      listener();
    }
  };
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", changed);
  };
}
