"use client";
import { t, uiMessage, useLocale } from "@/lib/i18n";

import { ChevronRight, FileText, Filter, Folder, FolderOpen } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo, useState } from "react";
import type { NoteSummary } from "@/lib/note-types";
import { ActionButton, useQuietMotion } from "./motion-system";

type Branch = { name: string; path: string; children: Map<string, Branch>; notes: NoteSummary[] };
type TreeProps = {
  notes: NoteSummary[];
  selected?: string;
  selectedId?: string | null;
  onFolder: (folder?: string) => void;
  onNote: (id: string) => void;
};
function inside(folder: string | undefined, parent: string) {
  return (
    folder !== undefined && (parent === "" || folder === parent || folder.startsWith(parent + "/"))
  );
}
function BranchNode({
  branch,
  selectedFolder,
  selectedNote,
  onFolder,
  onNote,
}: {
  branch: Branch;
  selectedFolder?: string;
  selectedNote?: NoteSummary;
  onFolder: TreeProps["onFolder"];
  onNote: TreeProps["onNote"];
}) {
  useLocale();
  const containsSelection =
    inside(selectedNote?.folder, branch.path) || inside(selectedFolder, branch.path);
  const [expanded, setExpanded] = useState(branch.path === "" || containsSelection);
  const selection = JSON.stringify([selectedNote?.id, selectedFolder, containsSelection]);
  const [previousSelection, setPreviousSelection] = useState(selection);
  const reduced = useQuietMotion();
  const contentId = useId();
  if (previousSelection !== selection) {
    setPreviousSelection(selection);
    if (containsSelection) setExpanded(true);
  }
  return (
    <motion.div layout={!reduced} className="folder-branch">
      <div className="folder-row">
        <ActionButton
          className="folder-heading"
          aria-label={t("目录 {0}", [branch.name])}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          <motion.span
            className="folder-chevron"
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={reduced ? { duration: 0 } : undefined}
          >
            <ChevronRight size={13} />
          </motion.span>
          {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          <span>{branch.name}</span>
        </ActionButton>
        <ActionButton
          className="folder-filter icon-button"
          aria-label={t("只看目录 {0}", [branch.name])}
          aria-pressed={selectedFolder === branch.path}
          title={t("筛选此目录")}
          onClick={() => onFolder(branch.path)}
        >
          <Filter size={13} />
        </ActionButton>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={contentId}
            key="children"
            className="folder-children"
            initial={reduced ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: reduced ? "auto" : 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.22, ease: [0.22, 0.72, 0.18, 1] }}
          >
            {[...branch.children.values()]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((child) => (
                <BranchNode
                  key={child.path}
                  branch={child}
                  selectedFolder={selectedFolder}
                  selectedNote={selectedNote}
                  onFolder={onFolder}
                  onNote={onNote}
                />
              ))}
            <AnimatePresence initial={false}>
              {branch.notes.map((note) => (
                <ActionButton
                  layout={!reduced}
                  className={`folder-note note-entry ${selectedNote?.id === note.id ? "selected" : ""}`}
                  aria-current={selectedNote?.id === note.id ? "page" : undefined}
                  key={note.id}
                  onClick={() => onNote(note.id)}
                >
                  <FileText size={14} />
                  <span>{note.title}</span>
                  {note.sync_status !== "synced" && (
                    <small>
                      {note.sync_status === "pending" ? t("同步未完成") : t("文件有冲突")} ·{" "}
                      {note.sync_error && uiMessage(note.sync_error.message)}
                    </small>
                  )}
                </ActionButton>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
export function FolderTree({ notes, selected, selectedId, onFolder, onNote }: TreeProps) {
  useLocale();
  const root = useMemo(() => {
    const tree: Branch = { name: t("根目录"), path: "", children: new Map(), notes: [] };
    for (const note of notes) {
      let current = tree;
      for (const name of note.folder.split("/").filter(Boolean)) {
        if (!current.children.has(name))
          current.children.set(name, {
            name,
            path: current.path ? current.path + "/" + name : name,
            children: new Map(),
            notes: [],
          });
        current = current.children.get(name)!;
      }
      current.notes.push(note);
    }
    return tree;
  }, [notes]);
  const selectedNote = notes.find((note) => note.id === selectedId);
  return (
    <div className="folder-tree" aria-label={t("逻辑目录树")}>
      <ActionButton
        className="folder-select"
        aria-pressed={selected === undefined}
        onClick={() => onFolder()}
      >
        {t("全部文档")}
      </ActionButton>
      <BranchNode
        branch={root}
        selectedFolder={selected}
        selectedNote={selectedNote}
        onFolder={onFolder}
        onNote={onNote}
      />
      <p className="notes-hint">{t("按目录归档 用标签跨目录查找")}</p>
    </div>
  );
}
