// One open repository: its toolbar, graph and details panel, with all of
// its state. Each tab owns a RepoView, so switching tabs keeps scroll
// position, selection and everything else.

import { openUrl, fetchCompare, fetchConflictHunks, fetchDiff, fetchFileDiff, fetchFileText, fetchHeadOpId, fetchLog, fetchTreeFiles, isTauri, jj, storage } from "./api";
import { DetailsPanel } from "./details";
import { Graph, ROW_HEIGHT } from "./graph";
import { OpLogPanel } from "./oplog";
import { Relations } from "./relations";
import { SearchBar, type SearchTarget } from "./search";
import { ResolveView } from "./resolve";
import { renderRow } from "./rows";
import { Sidebar, type SidebarItem } from "./sidebar";
import { escapeHtml, remoteWebUrl } from "./format";
import { type MenuEntry, confirm, copy, editText, notify, prompt, runWithToast, showHelp, showMenu } from "./ui";
import { showSettings } from "./settings";
import type { CommandOutput, CommitDiff, CompareDiff, LogResponse, LogRow } from "./types";

const OVERSCAN = 8;
/** Wait this long after the selection settles before loading its diff. */
const DETAILS_DELAY_MS = 40;
const DIFF_CACHE_SIZE = 64;

type RebaseMode = "revision" | "source" | "branch";
type Placement = "onto" | "after" | "before";

/**
 * A multi-step operation in progress, jjui-style: choose with the keyboard
 * or mouse, then Enter to run it or Esc to cancel. Nothing changes until then.
 */
type Pending =
  | { kind: "rebase"; source: number; mode: RebaseMode; placement: Placement; target: number }
  | { kind: "squash"; source: number; target: number; paths: string[] }
  | { kind: "abandon"; marked: Set<number> }
  /** ⇧M: choose a commit's parents, first parent first; its descendants follow. */
  | { kind: "parents"; source: number; marked: number[] }
  | { kind: "split"; source: number; message: string | null }
  /** Cherry-pick (jj duplicate) or revert, placed relative to a target. */
  | { kind: "duplicate"; source: number; placement: Placement; target: number }
  | { kind: "revert"; source: number; placement: Placement; target: number };

/**
 * The pending operation with its rows renumbered by `find`, for a reloaded
 * log. Marks whose commits are gone are dropped; null if the source or
 * target is gone.
 */
function remapPending(p: Pending, find: (index: number) => number | undefined): Pending | null {
  const found = (indexes: Iterable<number>) => [...indexes].map(find).filter((i) => i !== undefined);
  const source = "source" in p ? find(p.source) : undefined;
  switch (p.kind) {
    case "abandon":
      return { ...p, marked: new Set(found(p.marked)) };
    case "parents":
      return source === undefined ? null : { ...p, source, marked: found(p.marked) };
    case "split":
      return source === undefined ? null : { ...p, source };
    default: {
      const target = find(p.target);
      return source === undefined || target === undefined ? null : { ...p, source, target };
    }
  }
}

const PENDING_LABELS: Record<Pending["kind"], string> = {
  rebase: "Rebase",
  squash: "Squash",
  abandon: "Abandon",
  parents: "Set parents",
  split: "Split",
  duplicate: "Copy",
  revert: "Revert",
};

const MODE_LABELS: Record<RebaseMode, string> = {
  revision: "This commit",
  source: "With descendants",
  branch: "Whole branch",
};
const PLACEMENT_LABELS: Record<Placement, string> = { onto: "onto", after: "after", before: "before" };

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
  private relations: Relations | null = null;
  private pending: Pending | null = null;
  private searchBar = new SearchBar();
  /** Where ⌘F searches: the area last clicked in. */
  private searchZone: "graph" | "diff" = "graph";
  // Graph search: matching rows and the current one.
  private searchQuery = "";
  private searchMatches: number[] = [];
  private searchCurrent = -1;
  private modebar!: HTMLElement;
  private rendered = new Map<number, HTMLElement>();
  private loading = false;
  private frame = 0;

  // Diffs are cached by commit ID: a commit's content never changes.
  private diffCache = new Map<string, CommitDiff>();
  private detailsTimer = 0;
  private fullDiff = false;
  /** ←: the details panel shrinks to its tab bar, leaving the graph the window. */
  private detailsMin = false;
  private detailsRequest = 0;
  private details: DetailsPanel;
  private sidebar: Sidebar;
  private oplog: OpLogPanel;
  private resolver: ResolveView;
  /** The change being resolved; its commit changes with every resolution. */
  private resolving: LogRow | null = null;

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
        fileDiff: (from, to, file, force) => fetchFileDiff(this.path, from, to, file.path, file.sourcePath, force),
        treeFiles: (commitId) => fetchTreeFiles(this.path, commitId),
        fileMenu: (path) => this.fileMenu(path),
        splitChanged: () => this.updateModebar(),
        openResolve: (filePath, conflicts) => this.openResolve(filePath, conflicts),
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

    this.oplog = new OpLogPanel(
      this.ref("oplog"),
      path,
      (label, run) => this.act(label, run),
      (visible) => {
        // The op log takes the place of the graph and details while open.
        this.root.classList.toggle("showing-oplog", visible);
        this.ref("oplog-button").classList.toggle("active", visible);
        if (!visible) this.render();
      },
      (commitId) => {
        this.oplog.hide();
        this.selectCommit(commitId, "That commit");
      },
    );

    this.resolver = new ResolveView(this.ref("resolve"), {
      loadConflict: (commitId, filePath) => fetchConflictHunks(this.path, commitId, filePath),
      resolve: (filePath, content) =>
        this.resolveConflict(filePath, (row) => jj.resolve(this.path, row.commitId, filePath, content)),
      takeSide: (filePath, side) =>
        this.resolveConflict(filePath, (row) => jj.resolveSide(this.path, row.commitId, filePath, side)),
      close: () => this.closeResolve(),
    });

    this.sidebar = new Sidebar(this.ref("sidebar"), {
      select: (item) => this.selectCommit(item.commitId, item.name),
      contextMenu: (item) => this.sidebarMenu(item),
    });
    this.ref("repo-name").textContent = this.name;
    window.addEventListener("graph-date-change", () => {
      this.clearRows();
      this.render();
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
      if (!row || event.button !== 0) return;
      const index = Number(row.dataset.index);
      if (this.pending) {
        // While picking, clicks choose the destination or toggle a mark.
        if (this.pending.kind === "abandon" || this.pending.kind === "parents") {
          this.select(index, false);
          this.toggleMark(index);
        } else {
          this.setTarget(index);
        }
        return;
      }
      // ⌘-click picks a second commit to compare with the selected one.
      if (event.metaKey && this.selected >= 0) {
        this.setCompare(index === this.selected || index === this.compareIndex ? -1 : index);
      } else {
        this.compareIndex = -1;
        this.select(index, false);
        this.scheduleDetails();
        this.startDrag(event, index);
      }
    });
    this.ref("list").addEventListener("mousedown", () => (this.searchZone = "graph"), true);
    this.ref("diff-view").addEventListener("mousedown", () => (this.searchZone = "diff"), true);
    this.modebar = this.ref("modebar");
    this.modebar.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("button");
      const p = this.pending;
      if (!button || !p) return;
      if (button.dataset.action === "run") return this.runPending();
      if (button.dataset.action === "cancel") return this.cancelPending();
      if (button.dataset.action === "message" && p.kind === "split") return this.editSplitMessage();
      if (p.kind === "rebase" && button.dataset.mode) p.mode = button.dataset.mode as RebaseMode;
      if ("placement" in p && button.dataset.placement) p.placement = button.dataset.placement as Placement;
      this.updatePending();
    });
    this.ref("refresh").addEventListener("click", () => this.refresh());
    this.ref("fetch").addEventListener("click", () => this.act("Fetch", () => jj.gitFetch(this.path)));
    this.ref("push").addEventListener("click", () => this.act("Push", () => jj.gitPush(this.path)));
    this.ref("oplog-button").addEventListener("click", () => this.oplog.toggle());
    this.ref("help").addEventListener("click", () => showHelp());
    this.ref("full-diff-enter").addEventListener("click", () => this.toggleFullDiff());
    // Picking a tab brings a minimised panel back.
    this.ref("detail-tabs").addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-tab]")) this.setDetailsMin(false);
    });
    this.ref("full-diff-exit").addEventListener("click", () => this.toggleFullDiff());
    this.ref("settings").addEventListener("click", () => showSettings());
    this.ref("undo").addEventListener("click", () => this.act("Undo", () => jj.undo(this.path)));
    this.ref("redo").addEventListener("click", () => this.act("Redo", () => jj.redo(this.path)));
    this.spacer.addEventListener("contextmenu", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".row");
      if (!row) return;
      event.preventDefault();
      const index = Number(row.dataset.index);
      // Right-click selects the row, as a click does, so the menu's shortcuts
      // act on it too. Not while picking, where clicks choose a destination.
      const previous = this.selected;
      if (!this.pending && index !== this.selected) {
        this.compareIndex = -1;
        this.select(index, false);
        this.scheduleDetails();
      }
      this.commitMenu(index, previous);
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

  /**
   * Reloads after importing git refs, so tags and branches changed with the
   * git CLI show up. Fails quietly in repos without a git backend.
   */
  private async refresh() {
    this.statusEl.textContent = "Loading…";
    await jj.gitImport(this.path).catch(() => {});
    await this.load({ keepPosition: true });
  }

  async load({ keepPosition = false } = {}) {
    if (this.loading) return;
    this.loading = true;
    const previousIndex = this.selected;
    const previousRows = this.log?.rows ?? [];
    const previousChange = this.log && this.selected >= 0 ? this.log.rows[this.selected]?.changeId : null;
    const previousScroll = this.scroller.scrollTop;
    this.statusEl.textContent = "Loading…";
    try {
      const next = await fetchLog(this.path, this.revset);
      this.errorEl.hidden = true;
      this.log = next;
      this.graph = new Graph(next.rows, next.edges);
      this.relations = new Relations(next.rows.length, next.edges);
      // Carry an operation in progress over to the reloaded rows: by commit
      // ID, or by change ID if jj rewrote the commit meanwhile.
      if (this.pending) {
        const byCommit = new Map(next.rows.map((r, i) => [r.commitId, i]));
        const byChange = new Map(next.rows.map((r, i) => [r.changeId, i]));
        const find = (i: number) => {
          const row = previousRows[i];
          return row && (byCommit.get(row.commitId) ?? byChange.get(row.changeId));
        };
        const kind = this.pending.kind;
        this.pending = remapPending(this.pending, find);
        if (!this.pending) {
          if (kind === "split") this.details.endSplit();
          notify(`${PENDING_LABELS[kind]} cancelled: its commits are no longer in the graph`);
        }
      }
      this.updateModebar();
      this.name = next.workspaceRoot.split("/").pop() || next.workspaceRoot;
      this.showRepoName(next);
      this.revsetInput.placeholder = next.defaultRevset;
      const previousCompare = this.compareIndex >= 0 ? this.log?.rows[this.compareIndex]?.changeId : null;
      let selected = previousChange ? next.rows.findIndex((r) => r.changeId === previousChange) : -1;
      this.compareIndex = previousCompare ? next.rows.findIndex((r) => r.changeId === previousCompare) : -1;
      if (selected < 0 && !keepPosition) selected = next.rows.findIndex((r) => r.isWorkingCopy);
      this.selected = selected;
      this.spacer.style.height = `${next.rows.length * ROW_HEIGHT}px`;
      // Keep the selected commit where it was on screen, even if commits
      // were added or removed above it.
      const shift = keepPosition && selected >= 0 && previousIndex >= 0 ? (selected - previousIndex) * ROW_HEIGHT : 0;
      this.scroller.scrollTop = keepPosition ? previousScroll + shift : 0;
      // Redraw straight away: waiting for the next frame shows an empty list.
      this.clearRows();
      this.renderNow();
      this.updateStatus();
      this.sidebar.setData(next.sidebar);
      this.oplog.refresh();
      this.scheduleDetails(keepPosition);
      this.onChange();
    } catch (err) {
      this.errorEl.textContent = String(err);
      this.errorEl.hidden = false;
      this.statusEl.textContent = "";
    } finally {
      this.loading = false;
    }
  }

  /** The repo's folder name atop the sidebar, with the workspace when it isn't the default. */
  private showRepoName(log: LogResponse) {
    const el = this.ref("repo-name");
    const workspace = log.workspaceName !== "default" ? ` <span class="workspace-name">· ${escapeHtml(log.workspaceName)}</span>` : "";
    el.innerHTML = escapeHtml(this.name) + workspace;
    el.title = log.workspaceRoot;
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

  private searchMatchSet = new Set<number>();

  /** ⌘F: find in the graph, or in the diff or file if that was clicked last. */
  find() {
    if (this.searchZone === "diff" && this.root.querySelector(".vlines")) {
      this.searchBar.open(this.ref("details-body"), this.details.searchTarget);
    } else {
      this.searchBar.open(this.ref("list"), this.graphSearch);
    }
  }

  /** Searching the graph: descriptions, authors, IDs and ref names. */
  private graphSearch: SearchTarget = {
    setQuery: (query) => {
      this.searchQuery = query.toLowerCase();
      const q = this.searchQuery;
      this.searchMatches = [];
      (this.log?.rows ?? []).forEach((row, i) => {
        const haystack = [
          row.summary,
          row.authorName,
          row.authorEmail,
          row.changeId.slice(0, 12),
          row.commitId.slice(0, 12),
          ...row.refs.map((r) => ("remote" in r ? `${r.name}@${r.remote}` : r.name)),
          ...row.coauthors.map((c) => c.name),
        ]
          .join("\n")
          .toLowerCase();
        if (haystack.includes(q)) this.searchMatches.push(i);
      });
      this.searchMatchSet = new Set(this.searchMatches);
      // Continue from the selection.
      this.searchCurrent = this.searchMatches.findIndex((i) => i >= this.selected) - 1;
      if (this.searchCurrent < -1) this.searchCurrent = this.searchMatches.length - 1;
      this.render();
      return this.searchMatches.length;
    },
    step: (delta) => {
      const n = this.searchMatches.length;
      if (n === 0) return 0;
      this.searchCurrent = (this.searchCurrent + delta + n) % n;
      const index = this.searchMatches[this.searchCurrent];
      this.compareIndex = -1;
      this.select(index);
      this.scheduleDetails();
      return this.searchCurrent + 1;
    },
    clear: () => {
      this.searchQuery = "";
      this.searchMatches = [];
      this.searchMatchSet = new Set();
      this.render();
    },
  };

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
    // Typing in any text field (revset, prompts, the message editor, the
    // merge result) must never trigger single-key commands.
    const focused = event.target instanceof Element ? event.target : null;
    if (focused?.closest("input, textarea, select, [contenteditable]") || !this.log) return false;
    if (event.metaKey || event.ctrlKey) return false;
    if (this.oplog.visible) {
      if (event.key === "Escape" || event.key === "o") this.oplog.hide();
      return event.key === "Escape" || event.key === "o";
    }
    // The resolver owns the keyboard: n / p move between conflicts.
    if (this.resolver.visible) {
      if (event.key === "Escape") this.closeResolve();
      else if (event.key === "n" || event.key === "p") this.resolver.jump(event.key === "n" ? 1 : -1);
      return event.key === "Escape" || event.key.length === 1;
    }
    if (this.pending) return this.handlePendingKey(event);
    // Esc closes the find bar even after focus has left it.
    if (event.key === "Escape" && this.searchBar.isOpen) {
      this.searchBar.close();
      return true;
    }
    if (this.handleCommandKey(event)) return true;
    // ⌥↑/⌥↓ step through the selected commit's files, as plain ↑/↓ do at full size; j / k still move commits.
    if ((event.altKey || this.fullDiff) && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      this.details.moveFile(event.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_HEIGHT) - 1);
    const moves: Record<string, number> = {
      ArrowDown: this.selected + 1,
      j: this.selected + 1,
      ArrowUp: this.selected - 1,
      k: this.selected - 1,
      PageDown: this.selected + page,
      PageUp: this.selected - page,
      Home: 0,
      End: this.log.rows.length - 1,
    };
    if (event.key === "Escape" && this.fullDiff) {
      this.toggleFullDiff();
      return true;
    }
    // ← / → step the details panel between minimised, its usual size and full size.
    if (event.key === "ArrowLeft") {
      if (this.fullDiff) this.toggleFullDiff();
      else this.setDetailsMin(true);
      return true;
    }
    if (event.key === "ArrowRight") {
      if (this.detailsMin) this.setDetailsMin(false);
      else if (!this.fullDiff) this.toggleFullDiff();
      return true;
    }
    if (event.key === "Escape" && this.compareIndex >= 0) {
      this.setCompare(-1);
      return true;
    }
    if (!(event.key in moves)) return false;
    this.select(moves[event.key]);
    return true;
  }

  /** Single-key commands on the selected commit, as in jjui. */
  /**
   * Single-key commands, using jjui's default bindings so the muscle memory
   * carries over.
   */
  private handleCommandKey(event: KeyboardEvent): boolean {
    if (event.altKey) return false;
    const rows = this.log!.rows;
    // Commands that don't need a selected commit.
    switch (event.key) {
      case "u":
        this.act("Undo", () => jj.undo(this.path));
        return true;
      case "U":
        this.act("Redo", () => jj.redo(this.path));
        return true;
      case "o":
        this.oplog.toggle();
        return true;
      case "g":
        showMenu([
          { text: "Fetch", action: () => this.act("Fetch", () => jj.gitFetch(this.path)) },
          { text: "Push", action: () => this.act("Push", () => jj.gitPush(this.path)) },
        ]);
        return true;
      case "L":
        this.focusRevset();
        return true;
      case "?":
        showHelp();
        return true;
      case "@": {
        const wc = rows.findIndex((r) => r.isWorkingCopy);
        if (wc >= 0) this.select(wc);
        return true;
      }
    }
    if (this.selected < 0) return false;
    const row = rows[this.selected];
    switch (event.key) {
      case "r":
        this.startRebase(this.selected, "revision");
        return true;
      case "S":
        this.startSquash(this.selected);
        return true;
      case "s":
        this.startSplit(this.selected);
        return true;
      case "a":
        this.startAbandon(this.selected);
        return true;
      case "n":
        this.newChange(row);
        return true;
      case "e":
        this.editCommit(row);
        return true;
      case "Enter":
        // ↩ leaves the Commit tab showing afterwards; ⇧D goes back to where it was.
        this.describe(row, true);
        return true;
      case "D":
        this.describe(row);
        return true;
      case "d":
        // The first d brings up the Changes tab; the next fills the window with it.
        if (!this.fullDiff && this.details.currentTab !== "changes") this.details.setTab("changes");
        else this.toggleFullDiff();
        return true;
      case "y":
        this.startPlaced("duplicate", this.selected);
        return true;
      case "R":
        this.startPlaced("revert", this.selected);
        return true;
      case "A":
        this.act(`Absorb ${row.changeId.slice(0, 8)}`, () => jj.absorb(this.path, row.commitId), { undo: true });
        return true;
      case "B":
        this.setBookmark(row);
        return true;
      case "b":
        this.bookmarkMenu(this.selected);
        return true;
      case "M":
        this.startSetParents(this.selected);
        return true;
      case "J": {
        const parent = this.relations?.parentsOf(this.selected)[0];
        if (parent !== undefined) this.select(parent);
        return true;
      }
      case "K": {
        const child = this.relations ? [...this.relations.descendants([this.selected])].filter((r) => r !== this.selected).sort((x, y) => y - x)[0] : undefined;
        if (child !== undefined) this.select(child);
        return true;
      }
    }
    return false;
  }

  /** d: the details panel fills the window, as jjui's diff view does. ↑ / ↓ move between files, j / k between commits. */
  private toggleFullDiff() {
    this.setDetailsMin(false);
    this.fullDiff = !this.fullDiff;
    if (this.fullDiff) this.details.setTab("changes");
    this.root.classList.toggle("full-diff", this.fullDiff);
  }

  private setDetailsMin(min: boolean) {
    if (this.detailsMin === min) return;
    this.detailsMin = min;
    this.root.classList.toggle("details-min", min);
    this.render();
  }

  /** ⇧B: point a bookmark at the commit, creating it or moving it there. */
  private async setBookmark(row: LogRow) {
    const name = await prompt("Set Bookmark", `Create or move a bookmark to ${row.changeId.slice(0, 8)}`, "", "name");
    if (!name) return;
    const exists = this.localBookmarks().includes(name);
    this.act(
      `${exists ? "Move" : "Create"} bookmark ${name}`,
      () => (exists ? jj.bookmarkSet(this.path, name, row.commitId) : jj.bookmarkCreate(this.path, name, row.commitId)),
      { undo: true },
    );
  }

  private startRebase(source: number, mode: RebaseMode, target?: number) {
    this.pending = {
      kind: "rebase",
      source,
      mode,
      placement: "onto",
      // Default to the commit's first parent: rebasing there changes nothing.
      target: target ?? this.relations!.parentsOf(source)[0] ?? source,
    };
    this.compareIndex = -1;
    this.updatePending();
  }

  /**
   * Cherry-pick (y) or revert (⇧R): choose where the copy or the undoing
   * commit goes, onto `@` by default since that's usually where you are.
   */
  private startPlaced(kind: "duplicate" | "revert", source: number) {
    const wc = this.log!.rows.findIndex((r) => r.isWorkingCopy);
    const target = wc >= 0 ? wc : source;
    this.pending = { kind, source, placement: "onto", target } as Pending;
    this.compareIndex = -1;
    this.reveal(target);
    this.updatePending();
  }

  /** Squash a commit (or just `paths` from it) into another; the parent by default. */
  private startSquash(source: number, paths: string[] = []) {
    const parent = this.relations!.parentsOf(source)[0];
    this.pending = { kind: "squash", source, target: parent ?? source, paths };
    this.compareIndex = -1;
    this.updatePending();
  }

  /** Split: tick hunks in the Changes panel for the first commit, then Enter. */
  private startSplit(index: number) {
    this.select(index);
    this.scheduleDetails();
    this.pending = { kind: "split", source: index, message: null };
    this.compareIndex = -1;
    this.details.startSplit();
    this.updatePending();
  }

  private startAbandon(index: number) {
    this.pending = { kind: "abandon", marked: new Set([index]) };
    this.compareIndex = -1;
    this.updatePending();
  }

  /** ⇧M: starts from the current parents; Space adds or removes one. */
  private startSetParents(index: number) {
    this.pending = { kind: "parents", source: index, marked: [...this.relations!.directParentsOf(index)] };
    this.compareIndex = -1;
    this.updatePending();
  }

  private toggleMark(index: number) {
    const p = this.pending;
    if (p?.kind === "abandon") {
      if (p.marked.has(index)) p.marked.delete(index);
      else p.marked.add(index);
    } else if (p?.kind === "parents") {
      const at = p.marked.indexOf(index);
      if (at >= 0) p.marked.splice(at, 1);
      else p.marked.push(index);
    } else return;
    this.updatePending();
  }

  private cancelPending() {
    if (this.pending?.kind === "split") this.details.endSplit();
    this.pending = null;
    this.updatePending();
  }

  private setTarget(index: number) {
    const p = this.pending;
    if (!p || !("target" in p)) return;
    p.target = Math.max(0, Math.min(this.log!.rows.length - 1, index));
    this.reveal(p.target);
    this.updatePending();
  }

  private reveal(index: number) {
    const y = index * ROW_HEIGHT;
    if (y < this.scroller.scrollTop) this.scroller.scrollTop = y;
    else if (y + ROW_HEIGHT > this.scroller.scrollTop + this.scroller.clientHeight) {
      this.scroller.scrollTop = y + ROW_HEIGHT - this.scroller.clientHeight;
    }
  }

  /** Rows the pending rebase or squash would move, as best the loaded graph shows. */
  private movingRows(): Set<number> {
    const p = this.pending!;
    if (p.kind === "abandon") return p.marked;
    if (p.kind === "parents") return this.relations!.descendants([p.source]);
    if (p.kind !== "rebase" || p.mode === "revision") return new Set([p.source]);
    if (p.mode === "source") return this.relations!.descendants([p.source]);
    return this.relations!.branch([p.source], p.target);
  }

  private pendingProblem(): string | null {
    const p = this.pending!;
    const rows = this.log!.rows;
    if (p.kind === "abandon") {
      if (p.marked.size === 0) return "Mark commits to abandon with Space";
      if ([...p.marked].some((i) => rows[i].immutable)) return "Some marked commits are immutable";
      return null;
    }
    if (p.kind === "split") {
      const { selected, total } = this.details.splitCounts();
      if (rows[p.source].immutable) return "This commit is immutable";
      if (total === 0) return "This commit has no changes to split";
      if (selected === 0) return "Tick the changes for the first commit";
      if (selected === total) return "Leave something for the second commit";
      return null;
    }
    if (p.kind === "duplicate" || p.kind === "revert") return null;
    const moving = this.movingRows();
    if (p.kind === "parents") {
      const current = this.relations!.directParentsOf(p.source);
      if (rows[p.source].immutable) return "This commit is immutable";
      if (current.length < rows[p.source].parentCount) return "Some parents aren't shown; widen the revset to change them";
      if (p.marked.length === 0) return "Mark at least one parent with Space";
      if (p.marked.some((i) => moving.has(i))) return "A parent can't be the commit or one of its descendants";
      if (p.marked.length === current.length && p.marked.every((i, n) => i === current[n])) return "Mark different parents with Space";
      return null;
    }
    if (p.kind === "squash") {
      if (p.target === p.source) return "Pick another commit to squash into";
      if (rows[p.source].immutable || rows[p.target].immutable) return "Can't squash into or from an immutable commit";
      return null;
    }
    if (p.kind !== "rebase") return null;
    if (moving.has(p.target) && !(p.mode === "revision" && p.target !== p.source)) {
      return "Pick a destination outside the commits being moved";
    }
    if ([...moving].some((i) => rows[i].immutable)) return "Some of these commits are immutable";
    return null;
  }

  /** Keys inside a mode, following jjui's bindings for the same modes. */
  private handlePendingKey(event: KeyboardEvent): boolean {
    const p = this.pending!;
    const rows = this.log!.rows;
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_HEIGHT) - 1);
    const move = (to: number) => {
      // Splitting keeps the commit fixed; the arrows step through its files.
      if (p.kind === "split") this.details.moveFile(Math.sign(to - this.selected) as 1 | -1);
      else if (p.kind === "abandon" || p.kind === "parents") this.select(to);
      else this.setTarget(to);
    };
    const current = "target" in p ? p.target : this.selected;
    const moves: Record<string, number> = {
      ArrowDown: current + 1,
      j: current + 1,
      ArrowUp: current - 1,
      k: current - 1,
      PageDown: current + page,
      PageUp: current - page,
      Home: 0,
      End: rows.length - 1,
    };
    if (event.key in moves) {
      move(moves[event.key]);
      return true;
    }
    if (event.key === "@" && p.kind !== "split") {
      const wc = rows.findIndex((r) => r.isWorkingCopy);
      if (wc >= 0) move(wc);
      return true;
    }
    if (event.key === "Enter") {
      this.runPending();
      return true;
    }
    if (event.key === "Escape") {
      this.cancelPending();
      return true;
    }
    if (p.kind === "abandon") {
      if (event.key === " ") this.toggleMark(this.selected);
      else if (event.key === "s") {
        // Mark the selected commit's descendants too.
        for (const r of this.relations!.descendants([this.selected])) p.marked.add(r);
        this.updatePending();
      }
      return event.key.length === 1;
    }
    if (p.kind === "parents") {
      if (event.key === " ") this.toggleMark(this.selected);
      return event.key.length === 1;
    }
    if (p.kind === "rebase" || p.kind === "duplicate" || p.kind === "revert") {
      const modes: Record<string, RebaseMode> = { r: "revision", s: "source", B: "branch" };
      const placements: Record<string, Placement> = { o: "onto", a: "after", b: "before" };
      if (p.kind === "rebase" && event.key in modes) p.mode = modes[event.key];
      else if (event.key in placements) p.placement = placements[event.key];
      else return event.key.length === 1;
      this.updatePending();
      return true;
    }
    // Swallow other keys so they don't act on the list mid-operation.
    return event.key.length === 1;
  }

  private updatePending() {
    this.updateModebar();
    this.render();
  }

  private updateModebar() {
    const p = this.pending;
    this.root.classList.toggle("rebasing", !!p);
    if (!p || !this.log) {
      this.modebar.hidden = true;
      return;
    }
    const rows = this.log.rows;
    const id = (i: number) => `<span class="id change-id">${rows[i].changeId.slice(0, 8)}</span>`;
    const summary = (i: number) =>
      `<span class="modebar-summary">${escapeHtml(rows[i].summary || "(no description set)")}</span>`;
    const segment = <T extends string>(attr: string, value: T, current: T, label: string, key: string) =>
      `<button class="${value === current ? "active" : ""}" data-${attr}="${value}" title="${key}">${label}</button>`;
    const problem = this.pendingProblem();
    let body: string;
    let action: string;
    let hint: string;
    if (p.kind === "rebase") {
      const count = this.movingRows().size;
      body =
        `<span class="modebar-title">Rebase</span><span class="segmented">` +
        segment("mode", "revision", p.mode, MODE_LABELS.revision, "r") +
        segment("mode", "source", p.mode, MODE_LABELS.source, "s") +
        segment("mode", "branch", p.mode, MODE_LABELS.branch, "⇧B") +
        `</span>${id(p.source)}${count > 1 ? ` <span class="muted">+${count - 1}</span>` : ""}<span class="segmented">` +
        segment("placement", "onto", p.placement, PLACEMENT_LABELS.onto, "o") +
        segment("placement", "after", p.placement, PLACEMENT_LABELS.after, "a") +
        segment("placement", "before", p.placement, PLACEMENT_LABELS.before, "b") +
        `</span>${id(p.target)} ${summary(p.target)}`;
      action = "Rebase";
      hint = "↑↓ choose · Enter · Esc";
    } else if (p.kind === "duplicate" || p.kind === "revert") {
      const title = p.kind === "duplicate" ? "Copy" : "Revert";
      body =
        `<span class="modebar-title">${title}</span>${id(p.source)} ${summary(p.source)}<span class="segmented">` +
        segment("placement", "onto", p.placement, PLACEMENT_LABELS.onto, "o") +
        segment("placement", "after", p.placement, PLACEMENT_LABELS.after, "a") +
        segment("placement", "before", p.placement, PLACEMENT_LABELS.before, "b") +
        `</span>${id(p.target)} ${summary(p.target)}`;
      action = p.kind === "duplicate" ? "Copy" : "Revert";
      hint = "↑↓ choose · Enter · Esc";
    } else if (p.kind === "squash") {
      const what = p.paths.length === 0 ? "" : ` <span class="muted">(${p.paths.length === 1 ? escapeHtml(p.paths[0]) : `${p.paths.length} files`})</span>`;
      body = `<span class="modebar-title">Squash</span>${id(p.source)}${what} <span class="muted">into</span> ${id(p.target)} ${summary(p.target)}`;
      action = "Squash";
      hint = "↑↓ choose · Enter · Esc";
    } else if (p.kind === "split") {
      const { selected, total } = this.details.splitCounts();
      body =
        `<span class="modebar-title">Split</span>${id(p.source)} ${summary(p.source)}` +
        `<span class="muted">${selected} of ${total} ${total === 1 ? "change" : "changes"} ticked for the first commit</span>` +
        `<button class="modebar-button" data-action="message">${p.message === null ? "First commit message…" : "Edit message…"}</button>`;
      action = "Split";
      hint = "Tick files, hunks or lines · Enter · Esc";
    } else if (p.kind === "parents") {
      const parents = p.marked.length > 0 ? p.marked.map((i) => id(i)).join(" ") : `<span class="muted">none</span>`;
      body = `<span class="modebar-title">Set Parents</span>${id(p.source)} ${summary(p.source)} <span class="muted">onto</span> ${parents}`;
      action = "Set Parents";
      hint = "Space mark · Enter · Esc";
    } else {
      const count = p.marked.size;
      body = `<span class="modebar-title">Abandon</span><span>${count} ${count === 1 ? "commit" : "commits"} marked</span>`;
      action = "Abandon";
      hint = "Space mark · s descendants · Enter · Esc";
    }
    this.modebar.hidden = false;
    this.modebar.className = `modebar ${p.kind}`;
    this.modebar.innerHTML =
      body +
      (problem ? `<span class="modebar-problem">${escapeHtml(problem)}</span>` : "") +
      `<span class="modebar-actions"><span class="muted">${hint}</span>` +
      `<button data-action="cancel">Cancel</button><button data-action="run" class="primary"${problem ? " disabled" : ""}>${action}</button></span>`;
  }

  private async runPending() {
    const p = this.pending;
    if (!p || this.pendingProblem()) return;
    const rows = this.log!.rows;
    const short = (i: number) => rows[i].changeId.slice(0, 8);
    this.pending = null;
    this.updatePending();
    if (p.kind === "rebase") {
      await this.act(
        `Rebase ${short(p.source)} ${p.placement} ${short(p.target)}`,
        () => jj.rebase(this.path, [rows[p.source].commitId], p.mode, rows[p.target].commitId, p.placement),
        { undo: true },
      );
    } else if (p.kind === "duplicate" || p.kind === "revert") {
      const run = p.kind === "duplicate" ? jj.duplicateTo : jj.revert;
      await this.act(
        `${p.kind === "duplicate" ? "Copy" : "Revert"} ${short(p.source)} ${p.placement} ${short(p.target)}`,
        () => run(this.path, [rows[p.source].commitId], rows[p.target].commitId, p.placement),
        { undo: true },
      );
    } else if (p.kind === "parents") {
      await this.act(
        `Set parents of ${short(p.source)}`,
        () => jj.setParents(this.path, rows[p.source].commitId, p.marked.map((i) => rows[i].commitId)),
        { undo: true },
      );
    } else if (p.kind === "squash") {
      await this.act(
        `Squash ${short(p.source)} into ${short(p.target)}`,
        () => jj.squash(this.path, rows[p.source].commitId, rows[p.target].commitId, p.paths),
        { undo: true },
      );
    } else if (p.kind === "split") {
      const plan = this.details.splitPlan();
      this.details.endSplit();
      await this.act(
        `Split ${short(p.source)}`,
        () => jj.split(this.path, rows[p.source].commitId, plan, p.message),
        { undo: true },
      );
    } else {
      const marked = [...p.marked].sort((a, b) => a - b);
      await this.act(
        `Abandon ${marked.length === 1 ? short(marked[0]) : `${marked.length} commits`}`,
        () => jj.abandon(this.path, marked.map((i) => rows[i].commitId)),
        { undo: true },
      );
    }
  }

  /** Takes over the workspace to resolve the selected commit's conflicts. */
  private openResolve(filePath: string, conflicts: string[]) {
    const row = this.log?.rows[this.selected];
    if (!row) return;
    this.oplog.hide();
    this.resolving = row;
    this.root.classList.add("showing-resolve");
    this.resolver.open(row, conflicts, filePath);
  }

  private closeResolve() {
    const row = this.resolving;
    this.resolving = null;
    this.resolver.hide();
    this.root.classList.remove("showing-resolve");
    if (row) this.selectCommit(this.log?.rows.find((r) => r.changeId === row.changeId)?.commitId ?? null, row.changeId.slice(0, 8));
    this.render();
  }

  /**
   * Runs a resolution, then follows the change to its rewritten commit and
   * carries on with whatever is still conflicted, closing when nothing is.
   */
  private async resolveConflict(filePath: string, run: (row: LogRow) => Promise<CommandOutput>) {
    const row = this.resolving;
    if (!row) return;
    const ok = await runWithToast(`Resolve ${filePath}`, () => run(row), () => this.act("Undo", () => jj.undo(this.path)));
    await this.load({ keepPosition: true });
    if (!ok || !this.resolving) return;
    const next = this.log?.rows.find((r) => r.changeId === row.changeId);
    if (!next) return this.closeResolve();
    let conflicts: string[] = [];
    try {
      conflicts = (await fetchDiff(this.path, next.commitId)).conflicts;
    } catch {
      // Treat as done; the graph shows any conflict that's left.
    }
    this.resolving = next;
    if (conflicts.length === 0) return this.closeResolve();
    this.resolver.update(next, conflicts, undefined, filePath);
  }

  private async editSplitMessage() {
    const p = this.pending;
    if (p?.kind !== "split") return;
    const row = this.log!.rows[p.source];
    let message = p.message ?? row.summary;
    if (p.message === null) {
      try {
        message = (this.diffCache.get(row.commitId) ?? (await fetchDiff(this.path, row.commitId))).description;
      } catch {
        // Start from the summary.
      }
    }
    const edited = await editText("Message for the first commit", message, "⌥↩ or ⌘↩ to save");
    if (edited !== null && this.pending === p) {
      p.message = edited;
      this.updateModebar();
    }
  }

  private newChange(row: LogRow) {
    // With a second commit ⌘-clicked, make a merge of the two.
    const parents = [row];
    if (this.compareIndex >= 0) parents.push(this.log!.rows[this.compareIndex]);
    const label = parents.length > 1 ? "New merge" : `New change on ${row.changeId.slice(0, 8)}`;
    this.act(label, () => jj.newChange(this.path, parents.map((p) => p.commitId)), { undo: true });
  }

  private editCommit(row: LogRow) {
    this.act(`Edit ${row.changeId.slice(0, 8)}`, () => jj.edit(this.path, row.commitId), { undo: true });
  }

  private async describe(row: LogRow, stayOnCommit = false) {
    // The log only has the summary; the diff carries the full message.
    let message = row.summary;
    try {
      message = (this.diffCache.get(row.commitId) ?? (await fetchDiff(this.path, row.commitId))).description;
    } catch {
      // Edit the summary rather than nothing.
    }
    const edited = await this.details.editDescription(row, message, stayOnCommit);
    if (edited === null || edited.trim() === message.trim()) return;
    this.act(`Describe ${row.changeId.slice(0, 8)}`, () => jj.describe(this.path, row.commitId, edited), { undo: true });
  }

  /** Dragging a row onto another starts a rebase there (⇧ for descendants). */
  private startDrag(down: MouseEvent, index: number) {
    const startY = down.clientY;
    let dragging = false;
    const move = (e: MouseEvent) => {
      if (!dragging && Math.abs(e.clientY - startY) < 6) return;
      if (!dragging) {
        dragging = true;
        this.startRebase(index, e.shiftKey ? "source" : "revision", index);
        this.root.classList.add("dragging");
      }
      const p = this.pending;
      const over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(".row");
      if (over && p?.kind === "rebase") {
        p.mode = e.shiftKey ? "source" : e.altKey ? "branch" : "revision";
        if (Number(over.dataset.index) !== p.target) this.setTarget(Number(over.dataset.index));
        else this.updatePending();
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      this.root.classList.remove("dragging");
      // Dropping leaves the rebase ready to confirm, with the options visible.
      const p = this.pending;
      if (dragging && p?.kind === "rebase" && p.target === p.source) this.cancelPending();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, { once: true });
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
    const moving = this.pending && this.pending.kind !== "abandon" ? this.movingRows() : null;
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
      el.classList.toggle("search-hit", this.searchMatchSet.has(i));
      const p = this.pending;
      const target = p && "target" in p ? p.target : -1;
      el.classList.toggle("rebase-moving", !!moving?.has(i));
      el.classList.toggle("rebase-target", i === target);
      el.classList.toggle("abandon-marked", p?.kind === "abandon" && p.marked.has(i));
      el.classList.toggle("parent-marked", p?.kind === "parents" && p.marked.includes(i));
      el.dataset.placement = i === target && p && "placement" in p ? p.placement : i === target ? "onto" : "";
    }
  }

  private clearRows() {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
  }

  private select(index: number, reveal = true) {
    const log = this.log;
    if (!log || log.rows.length === 0) return;
    // Moving off a commit whose message is being edited drops the edit, after asking if it changed.
    if (this.details.editing && index !== this.selected) {
      if (this.details.editDirty) {
        confirm("Discard your changes to the commit message?", "Discard Changes", "Discard").then((ok) => {
          if (!ok) return;
          this.details.cancelEdit();
          this.select(index, reveal);
        });
        return;
      }
      this.details.cancelEdit();
    }
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

  /**
   * Shows the selected commit's details once its diff has loaded. A
   * `refresh` after a reload keeps the old diff up until the new one is in,
   * and keeps the panel's scroll position.
   */
  private scheduleDetails(refresh = false) {
    clearTimeout(this.detailsTimer);
    const row = this.log && this.selected >= 0 ? this.log.rows[this.selected] : null;
    this.sidebar.setSelectedCommit(row?.commitId ?? null);
    if (row && this.compareIndex >= 0 && this.compareIndex !== this.selected) {
      this.scheduleCompare(refresh);
      return;
    }
    if (!row) {
      this.details.clear(this.log ? "No commit selected" : "");
      return;
    }
    const cached = this.diffCache.get(row.commitId);
    if (cached) {
      this.details.show(row, cached, refresh);
      return;
    }
    if (!refresh) this.details.showPending(row);
    const request = ++this.detailsRequest;
    this.detailsTimer = window.setTimeout(async () => {
      try {
        const diff = await fetchDiff(this.path, row.commitId);
        this.diffCache.set(row.commitId, diff);
        if (this.diffCache.size > DIFF_CACHE_SIZE) this.diffCache.delete(this.diffCache.keys().next().value!);
        if (request === this.detailsRequest) this.details.show(row, diff, refresh);
      } catch (err) {
        if (request === this.detailsRequest) this.details.showError(String(err));
      }
    }, refresh ? 0 : DETAILS_DELAY_MS);
  }

  private scheduleCompare(refresh = false) {
    const rows = this.log!.rows;
    // Compare from the older commit (lower in the graph) to the newer.
    const [a, b] = [this.selected, this.compareIndex].sort((x, y) => y - x);
    const from = rows[this.compareSwapped ? b : a];
    const to = rows[this.compareSwapped ? a : b];
    const key = `${from.commitId}..${to.commitId}`;
    const cached = this.compareCache.get(key);
    if (cached) {
      this.details.showCompare(from, to, cached, refresh);
      return;
    }
    if (!refresh) this.details.showPendingCompare(from, to);
    const request = ++this.detailsRequest;
    this.detailsTimer = window.setTimeout(async () => {
      try {
        const diff = await fetchCompare(this.path, from.commitId, to.commitId);
        this.compareCache.set(key, diff);
        if (this.compareCache.size > DIFF_CACHE_SIZE) this.compareCache.delete(this.compareCache.keys().next().value!);
        if (request === this.detailsRequest) this.details.showCompare(from, to, diff, refresh);
      } catch (err) {
        if (request === this.detailsRequest) this.details.showError(String(err));
      }
    }, refresh ? 0 : DETAILS_DELAY_MS);
  }

  /** Runs a jj command with a toast, then reloads to show its effect. */
  private async act(label: string, run: () => Promise<CommandOutput>, options: { undo?: boolean } = {}) {
    const undo = options.undo ? () => this.act("Undo", () => jj.undo(this.path)) : undefined;
    await runWithToast(label, run, undo);
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

  /** The remote to publish to: the one most bookmarks use, else origin. */
  private defaultRemote(): string {
    const counts = new Map<string, number>();
    for (const b of this.log?.sidebar.bookmarks ?? []) {
      for (const r of b.remotes) counts.set(r.remote, (counts.get(r.remote) ?? 0) + 1);
    }
    if (counts.has("origin")) return "origin";
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "origin";
  }

  /** Menu entries to push a local bookmark, tracking it first if it's new on the remote. */
  private pushEntry(name: string): MenuEntry {
    const remote = this.defaultRemote();
    const bookmark = this.log?.sidebar.bookmarks.find((b) => b.name === name);
    const onRemote = bookmark?.remotes.some((r) => r.remote === remote);
    if (onRemote) return { text: `Push “${name}”`, action: () => this.act(`Push ${name}`, () => jj.gitPush(this.path, name)) };
    return {
      text: `Push “${name}” to ${remote} (new)`,
      action: () => this.act(`Push new bookmark ${name}`, () => jj.pushNewBookmark(this.path, name, remote)),
    };
  }

  private trackEntry(name: string, remote: string, tracked: boolean): MenuEntry {
    return tracked
      ? { text: `Untrack “${name}@${remote}”`, action: () => this.act(`Untrack ${name}@${remote}`, () => jj.bookmarkUntrack(this.path, name, remote)) }
      : { text: `Track “${name}@${remote}”`, action: () => this.act(`Track ${name}@${remote}`, () => jj.bookmarkTrack(this.path, name, remote)) };
  }

  private localBookmarks(): string[] {
    return (this.log?.sidebar.bookmarks ?? []).filter((b) => b.commitId).map((b) => b.name);
  }

  private async createBookmark(row: LogRow) {
    const name = await prompt("New Bookmark", `Create a bookmark at ${row.changeId.slice(0, 8)}`, "", "name");
    if (name) this.act(`Create bookmark ${name}`, () => jj.bookmarkCreate(this.path, name, row.commitId));
  }

  private tagsAt(row: LogRow): string[] {
    return row.refs.flatMap((r) => (r.type === "tag" ? [r.name] : []));
  }

  /** Push and delete for a tag, and delete from the remote if it has it. */
  private tagEntries(name: string): MenuEntry[] {
    const remote = this.defaultRemote();
    const entries: MenuEntry[] = [
      { text: `Push Tag “${name}” to ${remote}`, action: () => this.act(`Push tag ${name}`, () => jj.pushTag(this.path, name, remote)) },
      { text: `Delete Tag “${name}”…`, action: () => this.deleteTag(name) },
    ];
    const tag = this.log?.sidebar.tags.find((t) => t.name === name);
    if (tag?.remotes.includes(remote)) {
      entries.push({ text: `Delete Tag “${name}” from ${remote}…`, action: () => this.deleteRemoteTag(name, remote) });
    }
    return entries;
  }

  private async createTag(row: LogRow) {
    const name = await prompt("New Tag", `Create a tag at ${row.changeId.slice(0, 8)}`, "", "name");
    if (name) this.act(`Create tag ${name}`, () => jj.tagCreate(this.path, name, row.commitId));
  }

  private async deleteTag(name: string) {
    const ok = await confirm(
      `Delete tag "${name}"? This only deletes it here: if a remote has it, the next fetch brings it back. You can undo with jj undo.`,
      "Delete Tag",
      "Delete",
    );
    if (ok) this.act(`Delete tag ${name}`, () => jj.tagDelete(this.path, name));
  }

  private async deleteRemoteTag(name: string, remote: string) {
    const ok = await confirm(
      `Delete tag "${name}" from ${remote}? It's removed for everyone, and jj undo can't bring it back. Your local tag goes too if it points at the same commit, as jj follows the remote.`,
      "Delete Tag from Remote",
      "Delete",
    );
    if (ok) this.act(`Delete tag ${name} from ${remote}`, () => jj.deleteRemoteTag(this.path, name, remote));
  }

  private async deleteBookmark(name: string) {
    const ok = await confirm(
      `Delete bookmark "${name}"? On the next push, it's deleted from tracked remotes too. You can undo with jj undo.`,
      "Delete Bookmark",
      "Delete",
    );
    if (ok) this.act(`Delete bookmark ${name}`, () => jj.bookmarkDelete(this.path, name));
  }

  /**
   * b: bookmark commands for a commit, as jjui's bookmark menu has them. The
   * native menu takes the keyboard: arrows, typing to jump, ↩ to choose.
   */
  private bookmarkMenu(index: number) {
    const rows = this.log!.rows;
    const row = rows[index];
    const here = row.refs.filter((r) => r.type === "bookmark").map((r) => r.name);
    // Bookmarks nearest the commit in the graph first, then those not shown.
    const rowOf = new Map(rows.map((r, i) => [r.commitId, i]));
    const commitOf = new Map((this.log!.sidebar.bookmarks ?? []).map((b) => [b.name, b.commitId]));
    const distance = (name: string) => {
      const at = rowOf.get(commitOf.get(name) ?? "");
      return at === undefined ? Infinity : Math.abs(at - index);
    };
    const others = this.localBookmarks()
      .filter((n) => !here.includes(n))
      .sort((a, b) => distance(a) - distance(b) || a.localeCompare(b));
    const entries: MenuEntry[] = [
      { text: "New Bookmark Here…", action: () => this.createBookmark(row) },
      { text: "New Tag Here…", action: () => this.createTag(row) },
    ];
    for (const name of here) entries.push(this.pushEntry(name));
    for (const name of here) entries.push({ text: `Delete “${name}”…`, action: () => this.deleteBookmark(name) });
    const remotes = row.refs.flatMap((r) => (r.type === "remoteBookmark" ? [r] : []));
    for (const r of remotes) entries.push(this.trackEntry(r.name, r.remote, r.tracked));
    const tags = this.tagsAt(row);
    if (tags.length > 0) entries.push("separator", ...tags.flatMap((name) => this.tagEntries(name)));
    if (others.length > 0) {
      entries.push("separator");
      for (const name of others) {
        entries.push({
          text: `Move “${name}” Here`,
          action: () => this.act(`Move bookmark ${name}`, () => jj.bookmarkSet(this.path, name, row.commitId), { undo: true }),
        });
      }
    }
    entries.push("separator", {
      text: "Find Bookmark…",
      action: () => this.ref("sidebar").querySelector<HTMLInputElement>(".sidebar-filter")?.focus(),
    });
    this.reveal(index);
    const rect = this.rendered.get(index)?.querySelector(".summary")?.getBoundingClientRect();
    showMenu(entries, rect ? { x: rect.left, y: rect.bottom } : undefined);
  }

  /** `previous` is the row selected before the right-click, offered for comparison. */
  private commitMenu(index: number, previous = this.selected) {
    const row = this.log?.rows[index];
    if (!row) return;
    const here = row.refs.filter((r) => r.type === "bookmark").map((r) => r.name);
    const others = this.localBookmarks().filter((n) => !here.includes(n));
    const entries: MenuEntry[] = [
      { text: "New Change Here", shortcut: "N", action: () => this.newChange(row) },
      { text: "Edit", shortcut: "E", action: () => this.editCommit(row), enabled: !row.immutable },
      { text: "Describe…", shortcut: "Shift+D", action: () => this.describe(row), enabled: !row.immutable },
      "separator",
      { text: "Rebase…", shortcut: "R", action: () => this.startRebase(index, "revision") },
      { text: "Rebase with Descendants…", action: () => this.startRebase(index, "source") },
      { text: "Squash into…", shortcut: "Shift+S", action: () => this.startSquash(index), enabled: !row.immutable },
      { text: "Split…", shortcut: "S", action: () => this.startSplit(index), enabled: !row.immutable },
      { text: "Absorb into Ancestors", shortcut: "Shift+A", action: () => this.act(`Absorb ${row.changeId.slice(0, 8)}`, () => jj.absorb(this.path, row.commitId), { undo: true }), enabled: !row.immutable },
      { text: "Copy to… (Cherry-pick)", shortcut: "Y", action: () => this.startPlaced("duplicate", index) },
      { text: "Revert…", shortcut: "Shift+R", action: () => this.startPlaced("revert", index) },
      { text: "Abandon…", shortcut: "A", action: () => this.startAbandon(index), enabled: !row.immutable },
      "separator",
      { text: "New Bookmark Here…", action: () => this.createBookmark(row) },
      { text: "New Tag Here…", action: () => this.createTag(row) },
    ];
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
      for (const name of here) entries.push(this.pushEntry(name));
      for (const name of here) {
        entries.push({ text: `Delete “${name}”…`, action: () => this.deleteBookmark(name) });
      }
    }
    // Remote bookmarks here: start or stop tracking them.
    const remotes = row.refs.flatMap((r) => (r.type === "remoteBookmark" ? [r] : []));
    if (remotes.length > 0) {
      entries.push("separator");
      for (const r of remotes) entries.push(this.trackEntry(r.name, r.remote, r.tracked));
    }
    const tags = this.tagsAt(row);
    if (tags.length > 0) entries.push("separator", ...tags.flatMap((name) => this.tagEntries(name)));
    entries.push("separator");
    if (previous >= 0 && previous !== index) {
      entries.push({
        text: "Compare with Previous Selection",
        action: () => (this.selected === index ? this.setCompare(previous) : this.setCompare(index)),
      });
      entries.push("separator");
    }
    entries.push(
      { text: "Copy Change ID", action: () => copy(row.changeId) },
      { text: "Copy Commit ID", action: () => copy(row.commitId) },
      { text: "Copy Description", action: () => copy(row.summary) },
    );
    showMenu(entries);
  }

  private fileMenu(path: string) {
    const index = this.selected;
    const row = this.log?.rows[index];
    if (!row) return;
    const parent = this.relations?.parentsOf(index)[0];
    showMenu([
      {
        text: "Move to Parent",
        enabled: !row.immutable && parent !== undefined && !this.log!.rows[parent].immutable,
        action: () =>
          this.act(`Move ${path} to parent`, () => jj.squash(this.path, row.commitId, this.log!.rows[parent!].commitId, [path]), {
            undo: true,
          }),
      },
      { text: "Move to Commit…", enabled: !row.immutable, action: () => this.startSquash(index, [path]) },
      "separator",
      { text: "Copy Path", action: () => copy(path) },
    ]);
  }

  private sidebarMenu(item: SidebarItem) {
    const entries: MenuEntry[] = [];
    if (item.kind === "remoteRoot" && item.remote) {
      const remote = item.remote;
      const web = remoteWebUrl(item.url ?? null);
      entries.push({ text: `Fetch from ${remote}`, action: () => this.act(`Fetch ${remote}`, () => jj.gitFetch(this.path, remote)) });
      if (web) entries.push({ text: "Open in Browser", action: () => openUrl(web) });
      if (item.url) entries.push({ text: "Copy URL", action: () => copy(item.url!) });
      showMenu(entries);
      return;
    }
    if (item.kind === "bookmark") {
      entries.push(this.pushEntry(item.name), { text: `Delete “${item.name}”…`, action: () => this.deleteBookmark(item.name) });
      for (const r of item.bookmark?.remotes.filter((r) => r.tracked) ?? []) entries.push(this.trackEntry(item.name, r.remote, true));
      entries.push("separator");
    } else if (item.kind === "tag") {
      entries.push(...this.tagEntries(item.name), "separator");
    } else if (item.kind === "remote" && item.remote) {
      entries.push(this.trackEntry(item.name, item.remote, !!item.tracked), "separator");
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
