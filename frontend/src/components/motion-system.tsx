"use client";
import { createContext, useContext, ViewTransition, type ReactNode } from "react";
import {
  motion,
  MotionConfig,
  LayoutGroup,
  useIsPresent,
  type HTMLMotionProps,
} from "motion/react";
const Preference = createContext(false);
export const spring = { type: "spring", stiffness: 360, damping: 34, mass: 0.8 } as const;
export function InteractionProvider({
  reduced,
  children,
}: {
  reduced: boolean;
  children: ReactNode;
}) {
  return (
    <Preference.Provider value={reduced}>
      <MotionConfig
        reducedMotion={reduced ? "always" : "never"}
        transition={reduced ? { duration: 0 } : spring}
      >
        <LayoutGroup id="yihe">{children}</LayoutGroup>
      </MotionConfig>
    </Preference.Provider>
  );
}
export const useQuietMotion = () => useContext(Preference);
export function ActionButton(props: HTMLMotionProps<"button">) {
  const reduced = useQuietMotion();
  return (
    <motion.button
      data-motion-button="true"
      initial={reduced ? false : { opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: reduced ? 1 : 0.985 }}
      whileHover={reduced || props.disabled ? undefined : { scale: 1.025, y: -1 }}
      whileTap={reduced || props.disabled ? undefined : { scale: 0.97, y: 0 }}
      {...props}
    />
  );
}
export function WorkspaceSurface(props: HTMLMotionProps<"section">) {
  const reduced = useQuietMotion();
  return (
    <ViewTransition
      name="workspace"
      default="none"
      share={reduced ? "none" : "space-morph"}
      enter={reduced ? "none" : "space-enter"}
      exit={reduced ? "none" : "space-exit"}
    >
      <motion.section layout initial={false} {...props} />
    </ViewTransition>
  );
}
export function Entrance({ children, ...props }: HTMLMotionProps<"div">) {
  const reduced = useQuietMotion();
  const present = useIsPresent();
  return (
    <motion.div
      layout
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reduced ? 0 : -5 }}
      {...props}
      aria-hidden={!present || undefined}
      inert={!present}
    >
      {children}
    </motion.div>
  );
}
