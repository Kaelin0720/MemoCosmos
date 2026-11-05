"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Palette } from "lucide-react";
import {
  appearancesFor,
  families,
  ringDefs,
  type CelestialKind,
  type CelestialStyle,
} from "@/lib/celestial-materials";
import { t, useLocale } from "@/lib/i18n";
import { ActionButton } from "./motion-system";
import { Modal } from "./ui";
type RenderThumbnail = (kind: CelestialKind, surface: string) => HTMLCanvasElement | null;

function Thumbnail({
  kind,
  surface,
  renderer,
}: {
  kind: CelestialKind;
  surface: string;
  renderer: RenderThumbnail;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const deadline = performance.now() + 10000;
    const draw = () => {
      const image = renderer(kind, surface);
      if (image) canvas.current?.getContext("2d")?.drawImage(image, 0, 0);
      else if (performance.now() < deadline) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [kind, surface, renderer]);
  return <canvas width={128} height={128} ref={canvas} aria-hidden="true" />;
}
export function CelestialPicker({
  kind,
  value,
  onChange,
  renderer,
}: {
  kind: CelestialKind;
  value: CelestialStyle;
  onChange: (style: CelestialStyle) => void;
  renderer: RenderThumbnail;
}) {
  const locale = useLocale();
  const [open, setOpen] = useState(false),
    [family, setFamily] = useState("all"),
    [page, setPage] = useState(0);
  const definitions = appearancesFor(kind);
  const items = useMemo(
    () =>
      Object.entries(definitions).filter(([, def]) => family === "all" || def.family === family),
    [definitions, family],
  );
  const groups = [...new Set(Object.values(definitions).map((def) => def.family))];
  const pageSize = 6,
    pages = Math.max(1, Math.ceil(items.length / pageSize)),
    currentPage = Math.min(page, pages - 1);
  return (
    <div className="celestial-picker">
      <label>
        {t("天体外观")}
        <select
          aria-label={t("天体外观")}
          value={value.surface}
          onChange={(event) => onChange({ surface: event.target.value, ring: value.ring })}
        >
          {groups.map((group) => (
            <optgroup key={group} label={t(families[group])}>
              {Object.entries(definitions)
                .filter(([, def]) => def.family === group)
                .map(([key, def]) => (
                  <option key={key} value={key}>
                    {t(def.name, [], locale)}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <ActionButton
        className="secondary-button celestial-library-button"
        onClick={() => {
          setFamily("all");
          setPage(0);
          setOpen(true);
        }}
      >
        <Palette size={14} />
        {t("浏览外观库")}
        <span>{Object.keys(definitions).length}</span>
      </ActionButton>
      {kind === "planet" && (
        <label className="celestial-ring-label">
          {t("星环样式")}
          <select
            aria-label={t("星环样式")}
            value={value.ring ?? definitions[value.surface]?.ring ?? "none"}
            onChange={(event) => onChange({ ...value, ring: event.target.value })}
          >
            {Object.entries(ringDefs).map(([id, name]) => (
              <option key={id} value={id}>
                {t(name)}
              </option>
            ))}
          </select>
        </label>
      )}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t("天体外观库")}
        description={t("选择材质后立即应用，知识内容保持不变")}
      >
        <div className="celestial-family-filter" role="group" aria-label={t("外观分类")}>
          {["all", ...groups].map((group) => (
            <ActionButton
              key={group}
              className="text-button"
              aria-pressed={group === family}
              onClick={() => {
                setFamily(group);
                setPage(0);
              }}
            >
              {group === "all" ? t("全部") : t(families[group])}
            </ActionButton>
          ))}
        </div>
        <div className="celestial-library-grid">
          {items
            .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
            .map(([key, definition]) => (
              <ActionButton
                key={key}
                className="celestial-style-tile"
                aria-pressed={value.surface === key}
                onClick={() => {
                  onChange({ surface: key, ring: value.ring });
                  setOpen(false);
                }}
              >
                <Thumbnail kind={kind} surface={key} renderer={renderer} />
                <span>{t(definition.name)}</span>
              </ActionButton>
            ))}
        </div>
        <div className="celestial-library-pagination">
          <span aria-live="polite">
            {t("{0} / {1} 页 · {2} 种外观", [currentPage + 1, pages, items.length])}
          </span>
          <div>
            <ActionButton
              className="icon-button"
              aria-label={t("上一页外观")}
              disabled={currentPage === 0}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft size={16} />
            </ActionButton>
            <ActionButton
              className="icon-button"
              aria-label={t("下一页外观")}
              disabled={currentPage === pages - 1}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight size={16} />
            </ActionButton>
          </div>
        </div>
      </Modal>
    </div>
  );
}
