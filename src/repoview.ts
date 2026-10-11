// One open repository: its toolbar, graph and details panel, with all of
// its state. Each tab owns a RepoView, so switching tabs keeps scroll
// position, selection and everything else.

import { fetchCompare, fetchDiff, fetchFileText, fetchHeadOpId, fetchLog, fetchTreeFiles, isTauri, jj, storage } from "./api";
import { DetailsPanel } from "./details";
import { Graph, ROW_HEIGHT } from "./graph";
import { renderRow } from "./rows";
import { Sidebar, type SidebarItem } from "./sidebar";
import { type MenuEntry, confirm, copy, prompt, runWithToast, showMenu } from "./ui";
import type { CommandOutput, CommitDiff, CompareDiff, LogResponse, LogRow } from "./types";

const OVERSCAN = 8;
/** Wait this long after the selection settles before loading its diff. */
const DETAILS_DELAY_MS = 40;
const DIFF_CACHE_SIZE = 64;

export class RepoView {
  readonly root: HTMLElement;
  /** Shown in the tab; the folder name until the log loads. */
  name: string;
  onChange: () => void = () => {};

  /** The revset the user asked for; empty means the configured default. */
  private revset: string;
  private log: LogResponse | null = null;
  private graph: Graph | null = null;
  private selected = -1;
  /** The other commit in compare mode (⌘-click), or -1. */
  private compareIndex = -1;
  /** Compare from the upper commit to the lower instead of the reverse. */
  private compareSwapped = false;
  private compareCache = new Map<string, CompareDiff>();
  private rendered = new Map<number, HTMLElement>();
  private loading = false;
  private frame = 0;

  // Diffs are cached by commit ID: a commit's content never changes.
  private diffCache = new Map<string, CommitDiff>();
  private detailsTimer = 0;
  private detailsRequest = 0;
  private details: DetailsPanel;
  private sidebar: Sidebar;

  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private revsetInput: HTMLInputElement;
  private revsetPreset: HTMLSelectElement;
  private statusEl: HTMLElement;
  private errorEl: HTMLElement;

  constructor(
    template: HTMLTemplateElement,
    readonly path: string,
  ) {
    this.root = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    this.name = path.split("/").filter(Boolean).pop() ?? path;
    this.revset = storage(`revset:${path}`) ?? "";

    this.scroller = this.ref("scroller");
    this.spacer = this.ref("spacer");
    this.revsetInput = this.ref("revset-input");
    this.revsetPreset = this.ref("revset-preset");
    this.statusEl = this.ref("status");
    this.errorEl = this.ref("error");

    this.details = new DetailsPanel(
      {
        tabs: this.ref("detail-tabs"),
        info: this.ref("commit-info"),
        fileHeader: this.ref("file-header"),
        fileList: this.ref("file-list"),
        view: this.ref("diff-view"),
        body: this.ref("details-body"),
      },
      {
        fileText: (commitId, filePath) => fetchFileText(this.path, commitId, filePath),
        treeFiles: (commitId) => fetchTreeFiles(this.path, commitId),
        swapCompare: () => {
          this.compareSwapped = !this.compareSwapped;
          this.scheduleDetails();
        },
        selectChange: (changeId) => {
          const index = this.log?.rows.findIndex((r) => r.changeId === changeId) ?? -1;
          if (index >= 0) this.select(index);
        },
        save: (key, value) => storage(key, value),
      },
      { tab: storage("detailsTab"), changesView: storage("changesView") },
    );

    this.sidebar = new Sidebar(this.ref("sidebar"), {
      select: (item) => this.selectCommit(item.commitId, item.name),
      contextMenu: (item) => this.sidebarMenu(item),
    });

    this.revsetInput.value = this.revset;
    this.syncPreset();
    this.bindEvents();
    this.applySavedSizes();
  }

  private ref<T extends HTMLElement>(name: string): T {
    return this.root.querySelector<T>(`[data-ref="${name}"]`)!;
  }

  private bindEvents() {
    this.scroller.addEventListener("scroll", () => this.render(), { passive: true });
    new ResizeObserver(() => this.render()).observe(this.ref("list"));
    this.spacer.addEventListener("mousedown", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".row");
      if (!row) return;
      const index = Number(row.dataset.index);
      // ⌘-click picks a second commit to compare with the selected one.
      if (event.metaKey && this.selected >= 0) {
        this.setCompare(index === this.selected || index === this.compareIndex ? -1 : index);
      } else {
        this.compareIndex = -1;
        this.select(index, false);
        this.scheduleDetails();
      }
    });
    this.ref("refresh").addEventListener("click", () => this.load({ keepPosition: true }));
    this.ref("fetch").addEventListener("click", () => this.act("Fetch", () => jj.gitFetch(this.path)));
    this.ref("push").addEventListener("click", () => this.act("Push", () => jj.gitPush(this.path)));
    this.spacer.addEventListener("contextmenu", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".row");
      if (!row) return;
      event.preventDefault();
      this.commitMenu(Number(row.dataset.index));
    });
    this.revsetPreset.addEventListener("change", () => {
      if (this.revsetPreset.value !== "custom") this.applyRevset(this.revsetPreset.value);
    });
    this.revsetInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.applyRevset(this.revsetInput.value);
        this.revsetInput.blur();
      } else if (event.key === "Escape") {
        this.revsetInput.value = this.revset;
        this.revsetInput.blur();
      }
    });
    this.splitter(this.ref("split-sidebar"), this.ref("sidebar"), "columns", "sidebarWidth", 160, 0.4);
    this.splitter(this.ref("split-details"), this.ref("details"), "rows", "detailsHeight", 120, 0.85);
    this.splitter(this.ref("split-info"), this.ref("info-pane"), "columns", "infoWidth", 220, 0.6);
  }

  async load({ keepPosition = false } = {}) {
    if (this.loading) return;
    this.loading = true;
    const previousChange = this.log && this.selected >= 0 ? this.log.rows[this.selected]?.changeId : null;
    const previousScroll = this.scroller.scrollTop;
    this.statusEl.textContent = "Loading…";
    try {
      const next = await fetchLog(this.path, this.revset);
      this.errorEl.hidden = true;
      this.log = next;
      this.graph = new Graph(next.rows, next.edges);
      this.name = next.workspaceRoot.split("/").pop() || next.workspaceRoot;
      this.revsetInput.placeholder = next.defaultRevset;
      const previousCompare = this.compareIndex >= 0 ? this.log?.rows[this.compareIndex]?.changeId : null;
      let selected = previousChange ? next.rows.findIndex((r) => r.changeId === previousChange) : -1;
      this.compareIndex = previousCompare ? next.rows.findIndex((r) => r.changeId === previousCompare) : -1;
      if (selected < 0 && !keepPosition) selected = next.rows.findIndex((r) => r.isWorkingCopy);
      this.selected = selected;
      this.spacer.style.height = `${next.rows.length * ROW_HEIGHT}px`;
      this.clearRows();
      this.scroller.scrollTop = keepPosition ? previousScroll : 0;
      this.updateStatus();
      this.sidebar.setData(next.sidebar);
      this.render();
      this.scheduleDetails();
      this.onChange();
    } catch (err) {
      this.errorEl.textContent = String(err);
      this.errorEl.hidden = false;
      this.statusEl.textContent = "";
    } finally {
      this.loading = false;
    }
  }

  /** Reloads if jj has run an operation since the last load. */
  async pollForChanges() {
    if (!isTauri || !this.log || this.loading) return;
    try {
      const opId = await fetchHeadOpId(this.path);
      if (this.log && opId !== this.log.opId) await this.load({ keepPosition: true });
    } catch {
      // Errors surface on the next explicit load.
    }
  }

  /** Called when the tab is shown. */
  activate() {
    this.applySavedSizes();
    this.render();
  }

  /** Rebuilds the graph for a new device pixel ratio. */
  setDpr(dpr: number) {
    this.graph?.setDpr(dpr);
    this.clearRows();
    this.render();
  }

  focusRevset() {
    this.revsetInput.focus();
    this.revsetInput.select();
  }

  /** Handles keys for the list; returns whether the key was used. */
  handleKey(event: KeyboardEvent): boolean {
    if (document.activeElement === this.revsetInput || !this.log) return false;
    // ⌥↑/⌥↓ step through the selected commit's files.
    if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      this.details.moveFile(event.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_HEIGHT) - 1);
    const moves: Record<string, number> = {
      ArrowDown: this.selected + 1,
      ArrowUp: this.selected - 1,
      PageDown: this.selected + page,
      PageUp: this.selected - page,
      Home: 0,
      End: this.log.rows.length - 1,
    };
    if (event.key === "Escape" && this.compareIndex >= 0) {
      this.setCompare(-1);
      return true;
    }
    if (!(event.key in moves)) return false;
    this.select(moves[event.key]);
    return true;
  }

  private setCompare(index: number) {
    this.compareIndex = index;
    this.compareSwapped = false;
    this.render();
    this.scheduleDetails();
  }

  private updateStatus() {
    const log = this.log!;
    const count = `${log.rows.length.toLocaleString()} ${log.rows.length === 1 ? "commit" : "commits"}`;
    this.statusEl.textContent = `${count}${log.truncated ? " (truncated)" : ""} · ${log.elapsedMs} ms`;
    this.statusEl.title = `Operation ${log.opId}: ${log.opDescription}`;
  }

  private render() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderNow());
  }

  private renderNow() {
    const log = this.log;
    if (!log || !this.graph) return;
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight;
    if (height === 0) return; // Hidden tab.
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(log.rows.length - 1, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);

    for (const [index, el] of this.rendered) {
      if (index < first || index > last) {
        el.remove();
        this.rendered.delete(index);
      }
    }
    for (let i = first; i <= last; i++) {
      let el = this.rendered.get(i);
      if (!el) {
        el = document.createElement("div");
        el.className = "row";
        el.dataset.index = String(i);
        renderRow(el, log.rows[i], i, this.graph);
        this.spacer.appendChild(el);
        this.rendered.set(i, el);
      }
      el.classList.toggle("selected", i === this.selected);
      el.classList.toggle("compare", i === this.compareIndex);
    }
  }

  private clearRows() {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
  }

  private select(index: number, reveal = true) {
    const log = this.log;
    if (!log || log.rows.length === 0) return;
    const previous = this.selected;
    this.selected = Math.max(0, Math.min(log.rows.length - 1, index));
    if (this.selected !== previous) this.scheduleDetails();
    if (reveal) {
      const y = this.selected * ROW_HEIGHT;
      if (y < this.scroller.scrollTop) this.scroller.scrollTop = y;
      else if (y + ROW_HEIGHT > this.scroller.scrollTop + this.scroller.clientHeight) {
        this.scroller.scrollTop = y + ROW_HEIGHT - this.scroller.clientHeight;
      }
    }
    this.render();
  }

  private scheduleDetails() {
    clearTimeout(this.detailsTimer);
    const row = this.log && this.selected >= 0 ? this.log.rows[this.selected] : null;
    this.sidebar.setSelectedCommit(row?.commitId ?? null);
    if (row && this.compareIndex >= 0 && this.compareIndex !== this.selected) {
      this.scheduleCompare();
      return;
    }
    if (!row) {
      this.details.clear(this.log ? "No commit selected" : "");
      return;
    }
    const cached = this.diffCache.get(row.commitId);
    if (cached) {
      this.details.show(row, cached);
      return;
    }
    this.details.showPending(row);
    const request = ++this.detailsRequest;
    this.detailsTimer = window.setTimeout(async () => {
      try {
        const diff = await fetchDiff(this.path, row.commitId);
        this.diffCache.set(row.commitId, diff);
        if (this.diffCache.size > DIFF_CACHE_SIZE) this.diffCache.delete(this.diffCache.keys().next().value!);
        if (request === this.detailsRequest) this.details.show(row, diff);
      } catch (err) {
        if (request === this.detailsRequest) this.details.showError(String(err));
      }
    }, DETAILS_DELAY_MS);
  }

  private scheduleCompare() {
    const rows = this.log!.rows;
    // Compare from the older commit (lower in the graph) to the newer.
    const [a, b] = [this.selected, this.compareIndex].sort((x, y) => y - x);
    const from = rows[this.compareSwapped ? b : a];
    const to = rows[this.compareSwapped ? a : b];
    const key = `${from.commitId}..${to.commitId}`;
    const cached = this.compareCache.get(key);
    if (cached) {
      this.details.showCompare(from, to, cached);
      return;
    }
    this.details.showPendingCompare(from, to);
    const request = ++this.detailsRequest;
    this.detailsTimer = window.setTimeout(async () => {
      try {
        const diff = await fetchCompare(this.path, from.commitId, to.commitId);
        this.compareCache.set(key, diff);
        if (this.compareCache.size > DIFF_CACHE_SIZE) this.compareCache.delete(this.compareCache.keys().next().value!);
        if (request === this.detailsRequest) this.details.showCompare(from, to, diff);
      } catch (err) {
        if (request === this.detailsRequest) this.details.showError(String(err));
      }
    }, DETAILS_DELAY_MS);
  }

  /** Runs a jj command with a toast, then reloads to show its effect. */
  private async act(label: string, run: () => Promise<CommandOutput>) {
    await runWithToast(label, run);
    await this.load({ keepPosition: true });
  }

  /** Selects the row for a commit, if it's in the current view. */
  private selectCommit(commitId: string | null, what: string) {
    const index = commitId ? (this.log?.rows.findIndex((r) => r.commitId === commitId) ?? -1) : -1;
    if (index >= 0) {
      this.compareIndex = -1;
      this.select(index);
      this.scheduleDetails();
      // Bring it to the middle of the list.
      this.scroller.scrollTop = Math.max(0, index * ROW_HEIGHT - this.scroller.clientHeight / 2);
    } else {
      this.statusEl.textContent = `${what} isn't in the current revset`;
    }
  }

  private localBookmarks(): string[] {
    return (this.log?.sidebar.bookmarks ?? []).filter((b) => b.commitId).map((b) => b.name);
  }

  private async createBookmark(row: LogRow) {
    const name = await prompt("New Bookmark", `Create a bookmark at ${row.changeId.slice(0, 8)}`, "", "name");
    if (name) this.act(`Create bookmark ${name}`, () => jj.bookmarkCreate(this.path, name, row.commitId));
  }

  private async deleteBookmark(name: string) {
    const ok = await confirm(
      `Delete bookmark "${name}"? On the next push, it's deleted from tracked remotes too. You can undo with jj undo.`,
      "Delete Bookmark",
      "Delete",
    );
    if (ok) this.act(`Delete bookmark ${name}`, () => jj.bookmarkDelete(this.path, name));
  }

  private commitMenu(index: number) {
    const row = this.log?.rows[index];
    if (!row) return;
    const here = row.refs.filter((r) => r.type === "bookmark").map((r) => r.name);
    const others = this.localBookmarks().filter((n) => !here.includes(n));
    const entries: MenuEntry[] = [{ text: "New Bookmark Here…", action: () => this.createBookmark(row) }];
    if (others.length > 0) {
      entries.push({
        text: "Move Bookmark Here",
        items: others.map((name) => ({
          text: name,
          action: () => this.act(`Move bookmark ${name}`, () => jj.bookmarkSet(this.path, name, row.commitId)),
        })),
      });
    }
    if (here.length > 0) {
      entries.push("separator");
      for (const name of here) {
        entries.push({ text: `Push “${name}”`, action: () => this.act(`Push ${name}`, () => jj.gitPush(this.path, name)) });
      }
      for (const name of here) {
        entries.push({ text: `Delete “${name}”…`, action: () => this.deleteBookmark(name) });
      }
    }
    entries.push("separator");
    if (this.selected >= 0 && this.selected !== index) {
      entries.push({ text: "Compare with Selected", action: () => this.setCompare(index) });
      entries.push("separator");
    }
    entries.push(
      { text: "Copy Change ID", action: () => copy(row.changeId) },
      { text: "Copy Commit ID", action: () => copy(row.commitId) },
      { text: "Copy Description", action: () => copy(row.summary) },
    );
    showMenu(entries);
  }

  private sidebarMenu(item: SidebarItem) {
    const entries: MenuEntry[] = [];
    if (item.kind === "bookmark") {
      entries.push(
        { text: `Push “${item.name}”`, action: () => this.act(`Push ${item.name}`, () => jj.gitPush(this.path, item.name)) },
        { text: `Delete “${item.name}”…`, action: () => this.deleteBookmark(item.name) },
        "separator",
      );
    } else if (item.kind === "remote" && item.remote && !item.tracked) {
      const remote = item.remote;
      entries.push(
        { text: `Track “${item.name}@${remote}”`, action: () => this.act(`Track ${item.name}@${remote}`, () => jj.bookmarkTrack(this.path, item.name, remote)) },
        "separator",
      );
    }
    if (item.commitId) entries.push({ text: "Show in Graph", action: () => this.selectCommit(item.commitId, item.name) });
    entries.push({ text: "Copy Name", action: () => copy(item.remote ? `${item.name}@${item.remote}` : item.name) });
    showMenu(entries);
  }

  private syncPreset() {
    const match = [...this.revsetPreset.options].find((o) => o.value === this.revset && o.value !== "custom");
    this.revsetPreset.value = match ? match.value : "custom";
  }

  private applyRevset(value: string) {
    this.revset = value.trim();
    storage(`revset:${this.path}`, this.revset || null);
    this.sidebar = new Sidebar(this.ref("sidebar"), {
      select: (item) => this.selectCommit(item.commitId, item.name),
      contextMenu: (item) => this.sidebarMenu(item),
    });

    this.revsetInput.value = this.revset;
    this.syncPreset();
    this.load();
  }

  // Panel sizes are shared by all tabs, so re-read them when a tab is shown.
  private applySavedSizes() {
    const height = Number(storage("detailsHeight"));
    if (height) this.ref("details").style.height = `${height}px`;
    const width = Number(storage("infoWidth"));
    if (width) this.ref("info-pane").style.width = `${width}px`;
    const sidebarWidth = Number(storage("sidebarWidth"));
    if (sidebarWidth) this.ref("sidebar").style.width = `${sidebarWidth}px`;
  }

  /** Makes a splitter resize `target` along one axis, remembering the size. */
  private splitter(
    handle: HTMLElement,
    target: HTMLElement,
    axis: "rows" | "columns",
    key: string,
    min: number,
    maxFraction: number,
  ) {
    const apply = (size: number) => {
      const container = target.parentElement!;
      const total = axis === "rows" ? container.clientHeight : container.clientWidth;
      const clamped = Math.max(min, Math.min(size, total * maxFraction));
      target.style[axis === "rows" ? "height" : "width"] = `${clamped}px`;
      return clamped;
    };

    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add(`resizing-${axis}`);
      const start = axis === "rows" ? event.clientY : event.clientX;
      const rect = target.getBoundingClientRect();
      const startSize = axis === "rows" ? rect.height : rect.width;
      // The details panel sits below its splitter, so dragging up grows it.
      const sign = axis === "rows" ? -1 : 1;
      let size = startSize;
      const move = (e: PointerEvent) => {
        const delta = (axis === "rows" ? e.clientY : e.clientX) - start;
        size = apply(startSize + sign * delta);
        this.render();
      };
      const up = () => {
        document.body.classList.remove(`resizing-${axis}`);
        handle.removeEventListener("pointermove", move);
        storage(key, String(Math.round(size)));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
    });
  }
}
