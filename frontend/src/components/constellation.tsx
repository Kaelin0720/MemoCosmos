"use client";
import { t, useLocale } from "@/lib/i18n";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useSpace } from "./space-shell";
import { OrbitLayer, useMotionEnvironment, useOrbitalMotion } from "./ambient-motion";
import { useState } from "react";
export function Constellation() {
  useLocale();
  const { reduced } = useSpace();
  const environment = useMotionEnvironment();
  const [interacting, setInteracting] = useState(false);
  const { rotation } = useOrbitalMotion(
    reduced ||
      !environment.desktop ||
      !environment.visible ||
      environment.dialogOpen ||
      interacting,
    [200, 260],
    0.35,
  );
  return (
    <aside
      className={`constellation-preview ${reduced ? "still" : ""}`}
      aria-label={t("知识宇宙入口")}
      data-paused={interacting || !environment.visible || environment.dialogOpen}
      onPointerEnter={() => setInteracting(true)}
      onPointerLeave={() => setInteracting(false)}
      onFocusCapture={() => setInteracting(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setInteracting(false);
      }}
    >
      <div className="constellation-art" aria-hidden="true">
        <svg viewBox="0 0 400 520">
          <defs>
            <filter id="star-glow">
              <feGaussianBlur stdDeviation="4" />
            </filter>
          </defs>
          <OrbitLayer value={rotation}>
            <g className="constellation-orbits" fill="none">
              <ellipse cx="200" cy="260" rx="155" ry="190" />
              <ellipse cx="200" cy="260" rx="100" ry="128" />
            </g>
            <g className="constellation-links">
              <path d="M76 90L220 158L144 286L292 355L223 443M220 158L330 216L292 355M144 286L53 372" />
              <path className="light-flow" d="M76 90L220 158L144 286L292 355" />
            </g>
            <g className="star-halos" filter="url(#star-glow)">
              <circle cx="76" cy="90" r="8" />
              <circle cx="220" cy="158" r="12" />
              <circle cx="144" cy="286" r="10" />
              <circle cx="292" cy="355" r="11" />
              <circle cx="223" cy="443" r="7" />
            </g>
            <g className="star-cores">
              <circle cx="76" cy="90" r="3" />
              <circle cx="220" cy="158" r="4" />
              <circle cx="144" cy="286" r="3" />
              <circle cx="292" cy="355" r="4" />
              <circle cx="223" cy="443" r="2" />
              <circle cx="330" cy="216" r="2" />
              <circle cx="53" cy="372" r="2" />
            </g>
            <path
              className="constellation-spark"
              d="M220 139L224 154L239 158L224 162L220 177L216 162L201 158L216 154Z"
            />
          </OrbitLayer>
        </svg>
      </div>
      <div className="constellation-caption">
        <span className="eyebrow">{t("属于你的知识宇宙")}</span>
        <p>
          {t("每一次记住，")}
          <br />
          {t("都让星图更清晰。")}
        </p>
        <Link href="/knowledge/?view=graph&mode=explore">
          {t("探索星图 ")}
          <ArrowRight size={14} />
        </Link>
      </div>
    </aside>
  );
}
