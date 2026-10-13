import { api, ApiError, errorMessage, type Tag } from "./api";
import {
  validateNote,
  type NoteDetail,
  type NoteErrorDetails,
  type NoteInput,
  type NoteSummary,
  type NoteQuery,
  type NoteVersion,
} from "./note-types";

type Draft = NoteInput & { revision: number; base?: NoteDetail };
type SaveNotice = {
  kind: "success" | "error" | "uncertain";
  message: string;
  code?: string;
  details: NoteErrorDetails;
};
type State = {
  items: NoteSummary[];
  catalog: NoteSummary[];
  query: NoteQuery;
  total: number;
  listLoading: boolean;
  listError: string | null;
  tags: Tag[];
  tagsLoading: boolean;
  tagsReady: boolean;
  tagsError: string | null;
  draft: Draft;
  mode: "browse" | "create";
  saving: boolean;
  notice: SaveNotice | null;
  selectedId: string | null;
  detail: NoteDetail | null;
  reading: boolean;
  readError: string | null;
  readCode: string | null;
  hasDrafts: boolean;
  draftEntries: { key: string; title: string; editing: boolean }[];
};
const emptyDraft = (revision = 0): Draft => ({
  title: "",
  body: "",
  source: "",
  tag_ids: [],
  folder: "",
  revision,
});
const initial: State = {
  items: [],
  catalog: [],
  query: {},
  total: 0,
  listLoading: true,
  listError: null,
  tags: [],
  tagsLoading: true,
  tagsReady: false,
  tagsError: null,
  draft: emptyDraft(),
  mode: "browse",
  saving: false,
  notice: null,
  selectedId: null,
  detail: null,
  reading: false,
  readError: null,
  readCode: null,
  hasDrafts: false,
  draftEntries: [],
};
export const draftIsDirty = (draft: NoteInput & { base?: NoteDetail }) =>
  draft.base
    ? draft.title !== draft.base.title ||
      draft.body !== draft.base.body ||
      draft.source !== draft.base.source ||
      (draft.folder ?? "") !== draft.base.folder ||
      JSON.stringify([...draft.tag_ids].sort()) !==
        JSON.stringify(draft.base.tags.map((tag) => tag.id).sort())
    : Boolean(draft.title || draft.body || draft.source || draft.tag_ids.length || draft.folder);

// Session memory only: no storage, URL payloads or demo notes. The shell owns the unload warning.
class NotesStore {
  private state = initial;
  private listeners = new Set<() => void>();
  private listEpoch = 0;
  private catalogEpoch = 0;
  private tagEpoch = 0;
  private readEpoch = 0;
  private readAbort: AbortController | null = null;
  private revealedNote: string | null = null;
  private drafts = new Map<string, Draft>();
  private draftKey = "new";
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  serverSnapshot = () => initial;
  private update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.drafts.set(this.draftKey, this.state.draft);
    const draftEntries = [...this.drafts.entries()]
      .filter(([, draft]) => draftIsDirty(draft))
      .map(([key, draft]) => ({
        key,
        title: draft.title || "未命名文档",
        editing: Boolean(draft.base),
      }));
    this.state = { ...this.state, hasDrafts: draftEntries.length > 0, draftEntries };
    for (const listener of this.listeners) listener();
  }
  edit(patch: Partial<NoteInput>) {
    this.update({
      draft: { ...this.state.draft, ...patch, revision: this.state.draft.revision + 1 },
    });
  }
  create() {
    this.drafts.set(this.draftKey, this.state.draft);
    this.draftKey = "new";
    this.update({
      mode: "create",
      draft: this.drafts.get("new") ?? emptyDraft(this.state.draft.revision + 1),
    });
  }
  resume(key?: string) {
    const requested =
      key ?? (draftIsDirty(this.state.draft) ? this.draftKey : this.state.draftEntries[0]?.key);
    if (requested && this.drafts.has(requested)) {
      this.drafts.set(this.draftKey, this.state.draft);
      this.draftKey = requested;
      this.update({ mode: "create", draft: this.drafts.get(requested)! });
    } else this.update({ mode: "create" });
  }
  startEdit(detail: NoteDetail, history?: NoteVersion, replace = false) {
    this.drafts.set(this.draftKey, this.state.draft);
    const retained = this.drafts.get(detail.id);
    this.draftKey = detail.id;
    const value = history ?? detail;
    this.update({
      mode: "create",
      draft:
        retained && draftIsDirty(retained) && !replace
          ? retained
          : {
              title: value.title,
              body: value.body,
              source: value.source,
              folder: value.folder,
              tag_ids: value.tags.map((tag) => tag.id),
              base: detail,
              revision: this.state.draft.revision + 1,
            },
    });
  }
  setQuery(query: NoteQuery) {
    this.update({ query });
    void this.refreshList();
  }
  discard() {
    if (this.state.saving) return;
    const base = this.state.draft.base;
    this.update({
      draft: base
        ? {
            title: base.title,
            body: base.body,
            source: base.source,
            folder: base.folder,
            tag_ids: base.tags.map((tag) => tag.id),
            base,
            revision: this.state.draft.revision + 1,
          }
        : emptyDraft(this.state.draft.revision + 1),
      notice: null,
    });
  }
  reconcile(detail: NoteDetail, input: NoteInput) {
    this.startEdit(detail, undefined, true);
    this.edit(input);
    this.update({ notice: null });
  }
  async refreshTags() {
    const epoch = ++this.tagEpoch;
    this.update({ tagsLoading: true, tagsError: null });
    try {
      const result = await api.listTags();
      if (epoch === this.tagEpoch)
        this.update({ tags: result.items, tagsReady: true, tagsLoading: false });
    } catch (error) {
      if (epoch === this.tagEpoch)
        this.update({ tagsLoading: false, tagsError: errorMessage(error), tagsReady: false });
    }
  }
  async refreshList() {
    const epoch = ++this.listEpoch;
    this.update({ listLoading: true, listError: null });
    try {
      const result = await api.notes(undefined, this.state.query);
      if (epoch === this.listEpoch) this.update({ ...result, listLoading: false });
    } catch (error) {
      if (epoch === this.listEpoch)
        this.update({ listLoading: false, listError: errorMessage(error) });
    }
  }
  async refresh() {
    await Promise.allSettled([this.refreshList(), this.refreshTags(), this.refreshCatalog()]);
  }
  async refreshCatalog() {
    const epoch = ++this.catalogEpoch;
    try {
      const result = await api.notes();
      if (epoch === this.catalogEpoch) this.update({ catalog: result.items });
    } catch {
      /* visible list reports connection failures */
    }
  }
  async open(id: string) {
    const epoch = ++this.readEpoch;
    this.readAbort?.abort();
    const controller = new AbortController();
    this.readAbort = controller;
    this.update({
      selectedId: id,
      mode: "browse",
      detail: null,
      reading: true,
      readError: null,
      readCode: null,
    });
    try {
      const detail = await api.note(id, controller.signal);
      if (controller.signal.aborted || epoch !== this.readEpoch) return;
      if (detail.id !== id) throw new Error("服务返回了不同的文档，请重新读取。");
      if (detail.sync_status !== "synced")
        throw new Error(detail.sync_error?.message ?? "同步尚未完成，暂时无法读取当前正文。");
      if (this.revealedNote !== id) {
        this.revealedNote = id;
        const query = this.state.query;
        // Reveal linked documents outside the previous filter. Refreshing the
        // same note keeps any filters the user has intentionally changed.
        if (
          (query.q && !detail.title.toLocaleLowerCase().includes(query.q.toLocaleLowerCase())) ||
          (query.tag_id && !detail.tags.some((tag) => tag.id === query.tag_id)) ||
          (query.folder !== undefined && detail.folder !== query.folder)
        )
          this.setQuery({});
      }
      const { body, ...summary } = detail;
      void body;
      this.update({
        detail,
        reading: false,
        items: this.state.items.map((item) => (item.id === id ? summary : item)),
      });
    } catch (error) {
      if (!controller.signal.aborted && epoch === this.readEpoch) {
        this.update({
          reading: false,
          readError: errorMessage(error),
          readCode: error instanceof ApiError ? error.code : null,
          detail: null,
        });
        // Detail reads can discover a change or recover a pending write. A list
        // fetched before that read only described the previous check result.
        if (error instanceof ApiError && error.details.sync_status) void this.refreshList();
      }
    }
  }
  async save(): Promise<string | null> {
    if (this.state.saving) return null;
    const draft = this.state.draft;
    const key = this.draftKey;
    if (!this.state.tagsReady || this.state.tagsLoading) {
      this.update({
        notice: { kind: "error", message: "请先重新读取已有标签，再保存文档。", details: {} },
      });
      return null;
    }
    const input: NoteInput = {
      title: draft.title.trim(),
      body: draft.body,
      source: draft.source,
      tag_ids: [...draft.tag_ids],
      folder: draft.folder ?? "",
    };
    const invalid = validateNote(
      input,
      new Set(this.state.tags.map((tag) => tag.id)),
      Boolean(draft.base),
    );
    if (invalid) {
      this.update({ notice: { kind: "error", message: invalid, details: {} } });
      return null;
    }
    this.update({ saving: true, notice: null });
    try {
      const detail = draft.base
        ? await api.updateNote(draft.base.id, input, draft.base.version)
        : await api.createNote(input);
      if (
        detail.sync_status !== "synced" ||
        detail.title !== input.title ||
        detail.body !== input.body ||
        detail.source !== input.source ||
        detail.folder !== input.folder ||
        detail.tags.length !== input.tag_ids.length ||
        detail.tags.some((tag) => !input.tag_ids.includes(tag.id))
      )
        throw new ApiError(
          "invalid_response",
          "服务响应尚未确认这份稿件完整保存，请读取目录核对。",
          0,
          { note_id: detail.id, sync_status: detail.sync_status },
        );
      const unchanged = this.draftKey === key && this.state.draft.revision === draft.revision;
      const submittedDraft = this.drafts.get(key);
      if (submittedDraft?.revision === draft.revision) this.drafts.delete(key);
      let continued: Draft | undefined;
      if (!unchanged && submittedDraft && submittedDraft.revision !== draft.revision) {
        // This response confirms our submitted snapshot. Later typing is retained
        // against that confirmed version, rather than the obsolete pre-save base.
        continued = { ...submittedDraft, base: detail };
        this.drafts.set(detail.id, continued);
        if (key !== detail.id) this.drafts.delete(key);
        if (this.draftKey === key) this.draftKey = detail.id;
      }
      const shouldOpen = unchanged && this.state.mode === "create";
      this.update({
        saving: false,
        ...(unchanged ? { draft: emptyDraft(draft.revision + 1) } : {}),
        ...(!unchanged && continued && this.draftKey === detail.id ? { draft: continued } : {}),
        notice: {
          kind: "success",
          message: unchanged
            ? `已保存「${detail.title}」。`
            : `提交的「${detail.title}」已保存；当前新修改仍在草稿中。`,
          details: { note_id: detail.id },
        },
      });
      void this.refresh();
      return shouldOpen ? detail.id : null;
    } catch (error) {
      const known = error instanceof ApiError;
      const uncertain = !known || error.status === 0 || error.status >= 500;
      this.update({
        saving: false,
        notice: {
          kind: uncertain ? "uncertain" : "error",
          code: known ? error.code : undefined,
          message:
            known && error.code === "note_title_exists"
              ? "同标题文档已存在。新稿已保留，可以打开原文对照；不会覆盖或追加。"
              : uncertain
                ? `保存结果未确认。${errorMessage(error)} 草稿已保留，请读取目录或原文核对。`
                : `${errorMessage(error)} 草稿已保留。`,
          details: known ? error.details : {},
        },
      });
      if (known && ["invalid_tag_ids", "tag_not_found"].includes(error.code))
        void this.refreshTags();
      return null;
    }
  }
  async remove(id: string, version: number) {
    if (this.state.saving) return false;
    this.update({ saving: true, notice: null });
    try {
      await api.deleteNote(id, version);
      this.readAbort?.abort();
      ++this.readEpoch;
      this.drafts.delete(id);
      const deletingActive = this.draftKey === id;
      if (deletingActive) this.draftKey = "new";
      this.update({
        saving: false,
        selectedId: null,
        detail: null,
        reading: false,
        mode: "browse",
        ...(deletingActive
          ? { draft: this.drafts.get("new") ?? emptyDraft(this.state.draft.revision + 1) }
          : {}),
        notice: { kind: "success", message: "笔记与版本已删除，原始聊天仍独立保留。", details: {} },
      });
      await this.refresh();
      return true;
    } catch (error) {
      this.update({
        saving: false,
        notice: {
          kind: "error",
          message: `${errorMessage(error)} 删除结果未确认，请重新读取核对。`,
          details: error instanceof ApiError ? error.details : {},
        },
      });
      return false;
    }
  }
}
export const notesStore = new NotesStore();
