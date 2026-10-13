"use client";

import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type Ref,
  type SVGProps,
} from "react";
import { useMotionValue, useMotionValueEvent, useTransform, type MotionValue } from "motion/react";

// One subscription for the whole sky; no React state updates on animation frames.
const listeners = new Set<() => void>();
let release: (() => void) | undefined;
function environment() {
  if (typeof document === "undefined") return 1;
  return (
    (document.visibilityState === "visible" ? 1 : 0) |
    (window.matchMedia("(min-width: 851px)").matches ? 2 : 0) |
    (document.querySelector('[role="dialog"], [role="alertdialog"]') ? 4 : 0)
  );
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!release) {
    let previous = environment();
    const update = () => {
      const next = environment();
      if (next === previous) return;
      previous = next;
      listeners.forEach((notify) => notify());
    };
    const desktop = window.matchMedia("(min-width: 851px)");
    const observer = new MutationObserver(update);
    document.addEventListener("visibilitychange", update);
    desktop.addEventListener("change", update);
    observer.observe(document.body, { childList: true, subtree: true });
    release = () => {
      document.removeEventListener("visibilitychange", update);
      desktop.removeEventListener("change", update);
      observer.disconnect();
      release = undefined;
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) release?.();
  };
}
export function useMotionEnvironment() {
  const flags = useSyncExternalStore(subscribe, environment, () => 1);
  return {
    visible: Boolean(flags & 1),
    desktop: Boolean(flags & 2),
    dialogOpen: Boolean(flags & 4),
  };
}

export function useOrbitalMotion(paused: boolean, center: [number, number], speed = 0.65) {
  const angle = useMotionValue(0);
  const rotation = useTransform(angle, (value) => `rotate(${value} ${center[0]} ${center[1]})`);
  const upright = useTransform(angle, (value) => `rotate(${-value})`);
  useEffect(() => {
    if (paused) return;
    let frame: number;
    let previous: number | undefined;
    const step = (time: number) => {
      if (previous !== undefined)
        angle.set((angle.get() + (Math.min(time - previous, 64) * speed) / 1000) % 360);
      previous = time;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [angle, paused, speed]);
  return { angle, rotation, upright, reset: () => angle.set(0) };
}

// Motion's SVG renderer treats `transform` as CSS. Native SVG rotation centers
// use a different syntax, so keep that attribute on an ordinary SVG group.
export function OrbitLayer({
  value,
  ref,
  ...props
}: Omit<SVGProps<SVGGElement>, "ref" | "transform"> & {
  value: MotionValue<string>;
  ref?: Ref<SVGGElement>;
}) {
  const element = useRef<SVGGElement>(null);
  useImperativeHandle(ref, () => element.current!, []);
  useLayoutEffect(() => {
    element.current?.setAttribute("transform", value.get());
  }, [value]);
  useMotionValueEvent(value, "change", (transform) =>
    element.current?.setAttribute("transform", transform),
  );
  return <g {...props} ref={element} transform={value.get()} />;
}
