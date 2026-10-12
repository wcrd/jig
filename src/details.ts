// The panel under the graph, with three views of the selected commit:
// - Commit: details and changed files on the left, the selected diff right.
// - Changes: just the changed files (as a list or a tree) and the diff.
// - File Tree: the whole repository at that commit, with a file viewer.

import {
  type Expansion,
  diffLines,
  expandGap,
  fileLines,

  newExpansion,
  type SplitTicks,
  splitLines,
} from "./diffview";
import { buildTree, folderPaths, renderTree, type TreeNode } from "./filetree";
import type { SearchTarget } from "./search";
import { type LineSet, VirtualLines } from "./virtual";
import { highlightCached, languageFor, type Segment } from "./highlight";
import { agentBadge, avatarHtml } from "./agents";
import { escapeHtml, formatFullDate, reflowMessage } from "./format";
import type { CommitDiff, CompareDiff, FileDiff, FileStatus, FileText, LogRow, TreeEntry } from "./types";

export type DetailsTab = "commit" | "changes" | "tree";

/** Which changes go into the first commit of a split, as sent to `jj_split`. */
export interface SplitPlan {
  files: Record<string, { all: boolean; hunks: number[]; lines: Record<number, number[]> }>;
}

/** Indices of a hunk's added and removed lines. */
function changedLines(file: FileDiff, hunk: number): number[] {
  const out: number[] = [];
  file.hunks[hunk]?.lines.forEach((line, i) => {
    if (line.kind !== " ") out.push(i);
  });
  return out;
}

/** Ticked lines by hunk: a hunk with all its changed lines is wholly ticked. */
type SplitLines = Map<number, Set<number>>;
type ChangesView = "list" | "tree";

const STATUS_LETTER: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

const LIST_ICON = `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const TREE_ICON = `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 3.5h5M6 8h7M6 12.5h7M4 4v8.5h2M4 8h2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const COLLAPSE_ICON = `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4.5 6.5L8 3l3.5 3.5M4.5 9.5L8 13l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FILE_ICON = `<svg class="icon" viewBox="0 0 16 16" width="13" height="13"><path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

export interface DetailsSource {
  fileText(commitId: string, path: string): Promise<FileText>;
  /** Diffs one file that was left out of the commit's diff. */
  fileDiff(from: string | null, to: string, file: FileDiff, force: boolean): Promise<FileDiff>;
  treeFiles(commitId: string): Promise<TreeEntry[]>;
  /** Right-click on a changed file (not in compare mode). */
  fileMenu(path: string): void;
  /** Opens the conflict resolver on the shown commit, at `path`. */
  openResolve(path: string, conflicts: string[]): void;
  /** The split selection changed. */
  splitChanged(): void;
  /** Swap the direction of the current comparison. */
  swapCompare(): void;
  /** Select a commit in the graph by change ID, e.g. when a parent is clicked. */
  selectChange(changeId: string): void;
  /** Persist a UI preference. */
  save(key: string, value: string): void;
}

export interface DetailsElements {
  tabs: HTMLElement;
  info: HTMLElement;
  fileHeader: HTMLElement;
  fileList: HTMLElement;
  view: HTMLElement;
  /** Holds the left pane, splitter and view. */
  body: HTMLElement;
}

function statusBadge(status: FileStatus, conflict = false): string {
  return `<span class="status ${status}${conflict ? " conflict" : ""}">${conflict ? "!" : STATUS_LETTER[status]}</span>`;
}

export class DetailsPanel {
  private tab: DetailsTab;
  private changesView: ChangesView;
  private row: LogRow | null = null;
  private diff: CommitDiff | null = null;
  /** In compare mode, the commit compared from; `row` is the one compared to. */
  private compareFrom: LogRow | null = null;

  // Changed files.
  private fileIndex = 0;
  /** A conflicted file being viewed instead of a diff. */
  private conflictPath: string | null = null;

  private fileOrder: number[] = [];
  private changesCollapsed = new Set<string>();
  private changesTree: TreeNode | null = null;

  // Expanded diff context and file text, by commit and path.
  private expansions = new Map<string, Expansion>();
  private texts = new Map<string, Promise<FileText>>();

  // Repository browser.
  private treeCommit: string | null = null;
  private treeEntries: TreeEntry[] = [];
  private treeRoot: TreeNode | null = null;
  /** Folders are collapsed in the browser unless opened. */
  private treeOpen = new Set<string>();
  private treePath: string | null = null;
  private treeOrder: number[] = [];

  /**
   * In split mode, what's ticked for the first commit, by path: every change
   * in the file, or some of its lines. Unlisted files stay in the second.
   */
  private split: Map<string, "all" | SplitLines> | null = null;
  /** The last line ticked or unticked, for shift-click ranges. */
  private splitAnchor: { path: string; hunk: number; line: number; on: boolean } | null = null;

  /** Draws only the visible lines of large diffs and files. */
  private virtual: VirtualLines;

  /** The commit message being edited in place of the shown one. */
  private editor: {
    changeId: string;
    initial: string;
    el: HTMLElement;
    textarea: HTMLTextAreaElement;
    returnTab: DetailsTab;
    resolve: (value: string | null) => void;
  } | null = null;

  constructor(
    private el: DetailsElements,
    private source: DetailsSource,
    prefs: { tab?: string | null; changesView?: string | null },
  ) {
    this.virtual = new VirtualLines(el.view);
    this.tab = (["commit", "changes", "tree"].includes(prefs.tab ?? "") ? prefs.tab : "commit") as DetailsTab;
    this.changesView = prefs.changesView === "tree" ? "tree" : "list";

    el.tabs.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-action='swap']")) return this.source.swapCompare();
      const button = target.closest<HTMLElement>("[data-tab]");
      if (button) this.setTab(button.dataset.tab as DetailsTab);
    });
    el.fileHeader.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "list" || action === "tree") {
        this.changesView = action;
        this.source.save("changesView", action);
        this.renderLeft();
      } else if (action === "swap") {
        this.source.swapCompare();
      } else if (action === "collapse") {
        this.treeOpen.clear();
        this.renderLeft();
      }
    });
    el.fileList.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      const check = target.closest<HTMLElement>("[data-check]");
      if (check) {
        this.toggleSplitFile(Number(check.dataset.check));
        return;
      }
      const folder = target.closest<HTMLElement>("[data-folder]");
      if (folder) {
        this.toggleFolder(folder.dataset.folder!);
        return;
      }
      const conflict = target.closest<HTMLElement>("[data-conflict]");
      if (conflict) {
        this.conflictPath = conflict.dataset.conflict!;
        if (this.tab === "commit") this.setTab("changes");
        else {
          this.renderLeft();
          this.renderRight();
        }
        return;
      }
      const file = target.closest<HTMLElement>("[data-index]");
      if (file) this.selectItem(Number(file.dataset.index));
    });
    el.fileList.addEventListener("contextmenu", (event) => {
      const file = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (!file || this.tab === "tree" || this.compareFrom || !this.diff) return;
      event.preventDefault();
      const path = this.diff.files[Number(file.dataset.index)]?.path;
      if (path) this.source.fileMenu(path);
    });
    el.info.addEventListener("click", (event) => {
      const parent = (event.target as HTMLElement).closest<HTMLElement>("[data-change]");
      if (parent) source.selectChange(parent.dataset.change!);
    });
    el.view.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      const check = target.closest<HTMLElement>("[data-hunk-check]");
      if (check) {
        event.preventDefault();
        this.toggleSplitHunk(Number(check.dataset.hunkCheck));
        return;
      }
      const lineCheck = target.closest<HTMLElement>("[data-line-check]");
      if (lineCheck) {
        event.preventDefault();
        const [hunk, line] = lineCheck.dataset.lineCheck!.split(":").map(Number);
        this.toggleSplitLine(hunk, line, event.shiftKey);
      }
    });
    el.view.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("button");
      if (button) this.onViewButton(button);
    });
    this.renderTabs();
  }

  /** Find (⌘F) in the shown diff or file. */
  get searchTarget(): SearchTarget {
    return this.virtual;
  }

  clear(message = "") {
    this.cancelEdit();
    this.row = null;
    this.diff = null;
    this.el.info.innerHTML = message ? `<div class="placeholder-text">${escapeHtml(message)}</div>` : "";
    this.updateContext();
    this.el.fileHeader.innerHTML = "";
    this.el.fileList.innerHTML = "";
    this.el.view.innerHTML = "";
  }

  /** Shows the row's header straight away, before its diff has loaded. */
  showPending(row: LogRow) {
    if (this.row?.commitId === row.commitId && !this.compareFrom) return;
    if (this.editor && this.editor.changeId !== row.changeId) this.cancelEdit();
    this.compareFrom = null;
    this.row = row;
    this.diff = null;
    this.renderInfo();
    this.updateContext();
    this.renderLeft();
    if (this.tab !== "tree") this.el.view.innerHTML = "";
  }

  /** `refresh`: the repo reloaded, so keep scroll positions where the content allows. */
  show(row: LogRow, diff: CommitDiff, refresh = false) {
    // The same commit has the same diff; only its refs may have changed.
    if (refresh && !this.compareFrom && this.diff && this.row?.commitId === row.commitId) {
      this.row = row;
      this.renderInfo();
      this.updateContext();
      return;
    }
    const previousPath = this.diff?.files[this.fileIndex]?.path;
    if (this.split && this.row?.commitId !== row.commitId) this.split = new Map();
    if (this.editor && this.editor.changeId !== row.changeId) this.cancelEdit();
    this.compareFrom = null;
    this.row = row;
    this.diff = diff;
    this.changesTree = buildTree(diff.files.map((f) => f.path));
    this.renderInfo();
    this.updateContext();
    const found = previousPath ? diff.files.findIndex((f) => f.path === previousPath) : -1;
    this.fileIndex = found >= 0 ? found : 0;
    // With nothing changed but conflicts present, show the first conflict.
    this.conflictPath = diff.files.length === 0 && diff.conflicts.length > 0 ? diff.conflicts[0] : null;
    this.rerender(refresh && found >= 0);
    // The split bar's counts depend on the diff, which may arrive after it.
    if (this.split) this.source.splitChanged();
  }

  showPendingCompare(from: LogRow, to: LogRow) {
    this.cancelEdit();
    this.compareFrom = from;
    this.row = to;
    this.diff = null;
    this.el.info.innerHTML = this.compareInfoHtml(from, to);
    this.updateContext();
    this.renderLeft();
    if (this.tab !== "tree") this.el.view.innerHTML = "";
  }

  /**
   * Compare mode: the changes from one commit's snapshot to another's. The
   * file list, diffs and file tree all work as for a single commit, with the
   * "to" commit as the new side.
   */
  showCompare(from: LogRow, to: LogRow, compare: CompareDiff, refresh = false) {
    this.cancelEdit();
    const previousPath = this.diff?.files[this.fileIndex]?.path;
    this.conflictPath = null;
    this.compareFrom = from;
    this.row = to;
    this.diff = {
      commitId: to.commitId,
      changeId: to.changeId,
      description: to.summary,
      author: { name: to.authorName, email: to.authorEmail, timestamp: to.timestamp },
      committer: { name: to.authorName, email: to.authorEmail, timestamp: to.timestamp },
      parents: [],
      files: compare.files,
      conflicts: [],
    };
    this.changesTree = buildTree(compare.files.map((f) => f.path));
    this.el.info.innerHTML = this.compareInfoHtml(from, to);
    this.updateContext();
    const found = previousPath ? compare.files.findIndex((f) => f.path === previousPath) : -1;
    this.fileIndex = found >= 0 ? found : 0;
    this.rerender(refresh && found >= 0);
  }

  /** Redraws both sides for a new diff, keeping the scroll positions if asked. */
  private rerender(keepScroll: boolean) {
    const listScroll = this.el.fileList.scrollTop;
    this.renderLeft();
    if (keepScroll) this.el.fileList.scrollTop = listScroll;
    this.renderRight(keepScroll);
  }

  private compareInfoHtml(from: LogRow, to: LogRow): string {
    const side = (row: LogRow, label: string) =>
      `<div class="cmp-side"><span class="cmp-label">${label}</span><span class="id change-id"><b>${row.changeId.slice(0, row.changePrefixLen)}</b>${row.changeId.slice(row.changePrefixLen, 8)}</span>` +
      `<span class="cmp-summary">${row.summary ? escapeHtml(row.summary) : '<span class="placeholder">(no description set)</span>'}</span></div>`;
    return (
      `<div class="ci-summary">Comparing two commits</div>` +
      `<div class="cmp">${side(from, "From")}${side(to, "To")}</div>` +
      `<div class="muted cmp-hint">⌘-click another commit to change the comparison · Esc to stop comparing</div>`
    );
  }

  /** Shows what the panel is about after the tabs: the commit, or both ends of a comparison. */
  private updateContext() {
    let context = this.el.tabs.querySelector<HTMLElement>(".tab-context");
    if (!context) {
      context = document.createElement("div");
      context.className = "tab-context";
      this.el.tabs.appendChild(context);
    }
    const id = (row: LogRow) =>
      `<span class="id change-id"><b>${row.changeId.slice(0, row.changePrefixLen)}</b>${row.changeId.slice(row.changePrefixLen, 8)}</span>`;
    const summary = (row: LogRow) =>
      row.summary ? escapeHtml(row.summary) : `<span class="placeholder">(no description set)</span>`;
    const from = this.compareFrom;
    const to = this.row;
    if (!to) {
      context.innerHTML = "";
    } else if (from) {
      context.innerHTML =
        `<span class="ctx-compare" title="${escapeHtml(`${from.summary}  →  ${to.summary}`)}">${id(from)} <span class="ctx-summary">${summary(from)}</span>` +
        `<span class="ctx-arrow">→</span>${id(to)} <span class="ctx-summary">${summary(to)}</span></span>` +
        `<button class="header-button" data-action="swap" title="Swap direction">⇄</button>`;
    } else {
      context.innerHTML = `${id(to)} <span class="ctx-summary" title="${escapeHtml(to.summary)}">${summary(to)}</span>`;
    }
  }

  startSplit() {
    this.split = new Map();
    this.splitAnchor = null;
    if (this.tab !== "changes") this.setTab("changes");
    else {
      this.renderLeft();
      this.renderRight();
    }
  }

  endSplit() {
    if (!this.split) return;
    this.split = null;
    this.renderLeft();
    this.renderRight();
  }

  /** Changed lines ticked and in total (a file without hunks counts as one). */
  splitCounts(): { selected: number; total: number } {
    let selected = 0;
    let total = 0;
    for (const file of this.diff?.files ?? []) {
      const size = Math.max(1, file.hunks.reduce((n, _, g) => n + changedLines(file, g).length, 0));
      total += size;
      const state = this.split?.get(file.path);
      if (state === "all") selected += size;
      else for (const lines of state?.values() ?? []) selected += lines.size;
    }
    return { selected, total };
  }

  splitPlan(): SplitPlan {
    const files: SplitPlan["files"] = {};
    for (const file of this.diff?.files ?? []) {
      const state = this.split?.get(file.path);
      if (!state) continue;
      if (state === "all") {
        files[file.path] = { all: true, hunks: [], lines: {} };
        // A rename's source disappears along with it.
        if (file.sourcePath && file.status === "renamed") files[file.sourcePath] = { all: true, hunks: [], lines: {} };
        continue;
      }
      const hunks: number[] = [];
      const lines: Record<number, number[]> = {};
      for (const [g, ticked] of [...state].sort(([a], [b]) => a - b)) {
        if (ticked.size === changedLines(file, g).length) hunks.push(g);
        else lines[g] = [...ticked].sort((a, b) => a - b);
      }
      files[file.path] = { all: false, hunks, lines };
    }
    return { files };
  }

  private fileSplitState(file: FileDiff): "none" | "some" | "all" {
    const state = this.split?.get(file.path);
    if (!state) return "none";
    return state === "all" ? "all" : "some";
  }

  private hunkSplitState(file: FileDiff, hunk: number): "none" | "some" | "all" {
    const state = this.split?.get(file.path);
    if (!state) return "none";
    if (state === "all") return "all";
    const ticked = state.get(hunk)?.size ?? 0;
    return ticked === 0 ? "none" : ticked === changedLines(file, hunk).length ? "all" : "some";
  }

  /** Ticked lines of a file as a mutable map, expanding "all". */
  private splitLinesOf(file: FileDiff): SplitLines {
    const state = this.split?.get(file.path);
    if (state === "all") return new Map(file.hunks.map((_, g) => [g, new Set(changedLines(file, g))]));
    return new Map([...(state ?? [])].map(([g, lines]) => [g, new Set(lines)]));
  }

  /** Stores a file's ticked lines, collapsing to "all" or nothing. */
  private setSplitLines(file: FileDiff, lines: SplitLines) {
    for (const [g, set] of lines) if (set.size === 0) lines.delete(g);
    const all = file.hunks.length > 0 && file.hunks.every((_, g) => lines.get(g)?.size === changedLines(file, g).length);
    if (all) this.split!.set(file.path, "all");
    else if (lines.size === 0) this.split!.delete(file.path);
    else this.split!.set(file.path, lines);
  }

  private toggleSplitFile(index: number) {
    const file = this.diff?.files[index];
    if (!file || !this.split) return;
    if (this.fileSplitState(file) === "all") this.split.delete(file.path);
    else this.split.set(file.path, "all");
    this.splitUpdated();
  }

  private toggleSplitHunk(hunk: number) {
    const file = this.diff?.files[this.fileIndex];
    if (!file || !this.split) return;
    const lines = this.splitLinesOf(file);
    if (this.hunkSplitState(file, hunk) === "all") lines.delete(hunk);
    else lines.set(hunk, new Set(changedLines(file, hunk)));
    this.setSplitLines(file, lines);
    this.splitAnchor = null;
    this.splitUpdated();
  }

  /**
   * Ticks or unticks one changed line; with shift, every changed line from
   * the last one clicked in this file gets the same state.
   */
  private toggleSplitLine(hunk: number, line: number, range: boolean) {
    const file = this.diff?.files[this.fileIndex];
    if (!file || !this.split) return;
    const lines = this.splitLinesOf(file);
    const anchor = this.splitAnchor?.path === file.path ? this.splitAnchor : null;
    if (range && anchor) {
      const [from, to] = [[anchor.hunk, anchor.line], [hunk, line]].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (let g = from[0]; g <= to[0]; g++) {
        const set = lines.get(g) ?? new Set<number>();
        for (const i of changedLines(file, g)) {
          if ((g === from[0] && i < from[1]) || (g === to[0] && i > to[1])) continue;
          if (anchor.on) set.add(i);
          else set.delete(i);
        }
        lines.set(g, set);
      }
      this.splitAnchor = { ...anchor, hunk, line };
    } else {
      const set = lines.get(hunk) ?? new Set<number>();
      const on = !set.has(line);
      if (on) set.add(line);
      else set.delete(line);
      lines.set(hunk, set);
      this.splitAnchor = { path: file.path, hunk, line, on };
    }
    this.setSplitLines(file, lines);
    this.splitUpdated();
  }

  private splitUpdated() {
    this.renderLeft();
    this.renderDiff(false);
    this.source.splitChanged();
  }

  showError(message: string) {
    this.el.view.innerHTML = `<div class="placeholder-text error-text">${escapeHtml(message)}</div>`;
  }

  /** Moves the file selection, for keyboard navigation. */
  moveFile(delta: number) {
    const order = this.tab === "tree" ? this.treeOrder : this.fileOrder;
    if (order.length === 0) return;
    const current = this.tab === "tree" ? this.treeIndex() : this.fileIndex;
    const at = order.indexOf(current);
    const next = order[Math.max(0, Math.min(order.length - 1, at < 0 ? 0 : at + delta))];
    this.selectItem(next);
  }

  get currentTab(): DetailsTab {
    return this.tab;
  }

  setTab(tab: DetailsTab) {
    if (tab === this.tab) return;
    this.tab = tab;
    this.source.save("detailsTab", tab);
    this.renderTabs();
    this.renderLeft();
    this.renderRight();
  }

  private renderTabs() {
    for (const button of this.el.tabs.querySelectorAll<HTMLElement>("[data-tab]")) {
      button.classList.toggle("active", button.dataset.tab === this.tab);
    }
    this.el.info.hidden = this.tab !== "commit";
    // The Commit tab has no diff: details and files fill the panel.
    this.el.body.classList.toggle("commit-mode", this.tab === "commit");
  }

  // Left side: changed files or the repository tree.

  private renderLeft() {
    if (this.tab === "tree") this.renderRepoTree();
    else this.renderChanges();
  }

  private renderChanges() {
    const diff = this.diff;
    if (!diff) {
      this.el.fileHeader.innerHTML = this.row ? `<span>Changes</span>` : "";
      this.el.fileList.innerHTML = "";
      this.fileOrder = [];
      return;
    }
    const files = diff.files;
    const additions = files.reduce((n, f) => n + f.additions, 0);
    const deletions = files.reduce((n, f) => n + f.deletions, 0);
    const toggle = (view: ChangesView, icon: string, title: string) =>
      `<button class="header-button${this.changesView === view ? " active" : ""}" data-action="${view}" title="${title}">${icon}</button>`;
    this.el.fileHeader.innerHTML =
      `<span>${files.length} ${files.length === 1 ? "file" : "files"} changed</span>` +
      (files.length ? `<span class="stats"><span class="add">+${additions}</span> <span class="del">−${deletions}</span></span>` : "") +
      `<span class="header-buttons">${toggle("list", LIST_ICON, "Show as list")}${toggle("tree", TREE_ICON, "Show as tree")}</span>`;

    const conflicts = this.compareFrom ? "" : this.conflictsHtml(diff.conflicts);
    if (files.length === 0 && conflicts) {
      this.el.fileList.innerHTML = conflicts + `<div class="placeholder-text">No changes beyond its parents</div>`;
      this.fileOrder = [];
      return;
    }
    if (files.length === 0) {
      // jj diffs a merge against its auto-merged parents, so a clean merge
      // has no changes of its own.
      const message = this.compareFrom
        ? "The two commits have identical contents"
        : diff.parents.length > 1
          ? "Clean merge: no changes beyond its parents"
          : "No changes";
      this.el.fileList.innerHTML = `<div class="placeholder-text">${message}</div>`;
      this.fileOrder = [];
      return;
    }

    if (this.changesView === "tree") {
      const { html, order } = renderTree(this.changesTree!, {
        collapsed: this.changesCollapsed,
        selected: this.fileIndex,
        fileHtml: (i, node) => this.changedFileHtml(files[i], node.name, ""),
      });
      this.el.fileList.innerHTML = conflicts + (conflicts ? `<div class="list-section">Changes</div>` : "") + html;
      this.fileOrder = order;
    } else {
      this.el.fileList.innerHTML = conflicts + (conflicts ? `<div class="list-section">Changes</div>` : "") + files
        .map((file, i) => {
          const slash = file.path.lastIndexOf("/");
          const name = file.path.slice(slash + 1);
          const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
          return `<div class="tree-row file${i === this.fileIndex ? " selected" : ""}" data-index="${i}">${this.changedFileHtml(file, name, dir)}</div>`;
        })
        .join("");
      this.fileOrder = files.map((_, i) => i);
    }
  }

  private conflictsHtml(paths: string[]): string {
    if (paths.length === 0) return "";
    return (
      `<div class="list-section conflicts">Unresolved conflicts</div>` +
      paths
        .map((path) => {
          const slash = path.lastIndexOf("/");
          const selected = path === this.conflictPath ? " selected" : "";
          return `<div class="tree-row file${selected}" data-conflict="${escapeHtml(path)}" title="${escapeHtml(path)}">
            <span class="status modified conflict">!</span><span class="path"><span class="name">${escapeHtml(path.slice(slash + 1))}</span>${slash >= 0 ? `<span class="dir">${escapeHtml(path.slice(0, slash + 1))}</span>` : ""}</span></div>`;
        })
        .join("")
    );
  }

  private changedFileHtml(file: FileDiff, name: string, dir: string): string {
    const stats = file.binary
      ? `<span class="muted">bin</span>`
      : file.omitted
        ? ""
        : `<span class="add">+${file.additions}</span> <span class="del">−${file.deletions}</span>`;
    const title = file.sourcePath ? `${file.sourcePath} → ${file.path}` : file.path;
    const index = this.diff!.files.indexOf(file);
    const check = this.split
      ? `<span class="check ${{ none: "", some: "some", all: "on" }[this.fileSplitState(file)]}" data-check="${index}" title="Include in the first commit"></span>`
      : "";
    return `${check}${statusBadge(file.status, file.conflict)}<span class="path" title="${escapeHtml(title)}"><span class="name">${escapeHtml(name)}</span>${dir ? `<span class="dir">${escapeHtml(dir)}</span>` : ""}</span><span class="stats">${stats}</span>`;
  }

  private async renderRepoTree() {
    const row = this.row;
    this.el.fileHeader.innerHTML = `<span>Files</span>`;
    if (!row) {
      this.el.fileList.innerHTML = "";
      return;
    }
    if (this.treeCommit !== row.commitId) {
      this.el.fileList.innerHTML = `<div class="placeholder-text">Loading…</div>`;
      let entries: TreeEntry[];
      try {
        entries = await this.source.treeFiles(row.commitId);
      } catch (err) {
        this.el.fileList.innerHTML = `<div class="placeholder-text error-text">${escapeHtml(String(err))}</div>`;
        return;
      }
      // The selection may have moved on while loading.
      if (this.row?.commitId !== row.commitId || this.tab !== "tree") return;
      this.treeCommit = row.commitId;
      this.treeEntries = entries;
      this.treeRoot = buildTree(entries.map((e) => e.path));
      // Open the folders leading to the selected file.
      if (this.treePath) {
        const parts = this.treePath.split("/");
        for (let i = 1; i < parts.length; i++) this.treeOpen.add(parts.slice(0, i).join("/"));
      }
      this.renderRight();
    }

    const changed = new Map((this.diff?.files ?? []).map((f) => [f.path, f]));
    const collapsed = new Set(folderPaths(this.treeRoot!).filter((p) => !this.isTreeFolderOpen(p)));
    const { html, order } = renderTree(this.treeRoot!, {
      collapsed,
      selected: this.treeIndex(),
      fileHtml: (i, node) => {
        const file = changed.get(this.treeEntries[i].path);
        const badge = file ? statusBadge(file.status, file.conflict) : FILE_ICON;
        return `${badge}<span class="path"><span class="name">${escapeHtml(node.name)}</span></span>`;
      },
    });
    this.el.fileHeader.innerHTML =
      `<span>${this.treeEntries.length.toLocaleString()} files</span>` +
      `<span class="header-buttons"><button class="header-button" data-action="collapse" title="Collapse all folders">${COLLAPSE_ICON}</button></span>`;
    this.el.fileList.innerHTML = html;
    this.treeOrder = order;
  }

  /** A compressed folder node ("a/b") is open when its deepest folder is. */
  private isTreeFolderOpen(path: string): boolean {
    return this.treeOpen.has(path);
  }

  private treeIndex(): number {
    if (!this.treePath) return -1;
    return this.treeEntries.findIndex((e) => e.path === this.treePath);
  }

  private toggleFolder(path: string) {
    if (this.tab === "tree") {
      if (this.treeOpen.has(path)) this.treeOpen.delete(path);
      else this.treeOpen.add(path);
    } else if (this.changesCollapsed.has(path)) {
      this.changesCollapsed.delete(path);
    } else {
      this.changesCollapsed.add(path);
    }
    this.renderLeft();
  }

  private selectItem(index: number) {
    if (this.tab === "tree") {
      const path = this.treeEntries[index]?.path;
      if (!path || path === this.treePath) return;
      this.treePath = path;
    } else if (this.tab === "commit") {
      // Opening a file from the Commit tab shows its diff in Changes.
      if (!this.diff) return;
      this.fileIndex = index;
      this.setTab("changes");
      return;
    } else {
      if (!this.diff || (index === this.fileIndex && !this.conflictPath)) return;
      this.fileIndex = index;
      if (this.conflictPath) {
        this.conflictPath = null;
        this.renderLeft();
      }
    }
    for (const el of this.el.fileList.querySelectorAll<HTMLElement>(".tree-row.file")) {
      el.classList.toggle("selected", Number(el.dataset.index) === index);
    }
    this.el.fileList.querySelector(".tree-row.file.selected")?.scrollIntoView({ block: "nearest" });
    this.renderRight();
  }

  // Right side: the diff, or a file from the repository tree.

  private renderRight(keepScroll = false) {
    if (this.tab === "commit") return;
    if (this.tab === "tree") this.renderTreeFile(keepScroll);
    else if (this.conflictPath) this.renderConflict(this.conflictPath);
    else this.renderDiff(!keepScroll);
  }

  private key(path: string): string {
    return `${this.row?.commitId}:${path}`;
  }

  private text(path: string): Promise<FileText> {
    const key = this.key(path);
    let text = this.texts.get(key);
    if (!text) {
      text = this.source.fileText(this.row!.commitId, path);
      text.catch(() => this.texts.delete(key));
      this.texts.set(key, text);
      // Keep the cache bounded.
      if (this.texts.size > 200) this.texts.delete(this.texts.keys().next().value!);
    }
    return text;
  }

  private async renderDiff(resetScroll: boolean) {
    const file = this.diff?.files[this.fileIndex];
    if (!file) {
      this.el.view.innerHTML = "";
      return;
    }
    if (file.omitted) {
      this.renderOmitted(file);
      return;
    }
    const key = this.key(file.path);
    const expansion = this.expansions.get(key) ?? newExpansion();
    // Use the file's text only if it's already been fetched for expanding.
    const language = languageFor(file.path);
    let lines: string[] | null = null;
    let highlight: Segment[][] | null = null;
    if (this.texts.has(key)) {
      const text = await this.texts.get(key)!.catch(() => null);
      if (this.diff?.files[this.fileIndex] !== file) return;
      if (text?.text != null) {
        lines = splitLines(text.text);
        highlight = highlightCached(text, text.text, language);
      }
    }
    const canExpand = !file.binary && !file.omitted && file.status !== "deleted" && file.hunks.length > 0;
    const fullButton = canExpand
      ? `<button class="header-button text${expansion.full ? " active" : ""}" data-action="full" title="Show the whole file">Full file</button>`
      : "";
    const rename = file.sourcePath ? `<span class="muted">${escapeHtml(file.sourcePath)} → </span>` : "";
    const scrollTop = this.el.view.scrollTop;
    const scrollLeft = this.el.view.scrollLeft;
    this.el.view.innerHTML =
      `<div class="diff-header">${statusBadge(file.status, file.conflict)}<span class="diff-path">${rename}${escapeHtml(file.path)}</span>` +
      (file.conflict ? `<span class="pill flag conflict"><span class="label">conflict</span></span>` : "") +
      `<span class="header-buttons">${fullButton}</span></div>` +
      `<div class="diff-body"></div>`;
    const state = this.split?.get(file.path);
    const ticked: SplitTicks | null = this.split
      ? {
          hunk: (g) => this.hunkSplitState(file, g),
          line: (g, i) => state === "all" || !!state?.get(g)?.has(i),
        }
      : null;
    this.showLines(diffLines(file, expansion, lines, language, highlight, ticked));
    this.el.view.scrollTop = resetScroll ? 0 : scrollTop;
    this.el.view.scrollLeft = resetScroll ? 0 : scrollLeft;
  }

  /**
   * A file left out of the commit's diff: load it now, unless it's over the
   * size limit, in which case offer to.
   */
  private async renderOmitted(file: FileDiff, force = false) {
    const header =
      `<div class="diff-header">${statusBadge(file.status, file.conflict)}<span class="diff-path">${escapeHtml(file.path)}</span></div>`;
    this.virtual.unmount();
    if (file.tooLarge && !force) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      this.el.view.innerHTML =
        header +
        `<div class="placeholder-text">This file is ${mb} MB, so it wasn't diffed automatically; large files can take a while.` +
        `<div><button class="header-button text load-anyway" data-action="force">Show Diff Anyway</button></div></div>`;
      return;
    }
    this.el.view.innerHTML = header + `<div class="placeholder-text">Loading diff…</div>`;
    const diff = this.diff;
    const index = this.fileIndex;
    try {
      const loaded = await this.source.fileDiff(this.compareFrom?.commitId ?? null, this.row!.commitId, file, force);
      // Store it in place so the cached commit diff keeps it.
      if (diff?.files[index] === file) diff.files[index] = loaded;
    } catch (err) {
      if (this.diff === diff && this.fileIndex === index) this.showError(String(err));
      return;
    }
    if (this.diff !== diff || this.fileIndex !== index || this.tab === "tree") return;
    this.renderLeft();
    this.renderDiff(true);
  }

  /** A conflicted file, with jj's conflict markers highlighted. */
  private async renderConflict(path: string) {
    const row = this.row;
    this.virtual.unmount();
    const header =
      `<div class="diff-header"><span class="status modified conflict">!</span><span class="diff-path">${escapeHtml(path)}</span>` +
      `<span class="pill flag conflict"><span class="label">unresolved conflict</span></span>` +
      (this.compareFrom ? "" : `<span class="header-buttons"><button class="header-button text primary" data-action="resolve-conflict">Resolve…</button></span>`) +
      `</div>`;
    this.el.view.innerHTML = header + `<div class="placeholder-text">Loading…</div>`;
    let text: FileText;
    try {
      text = await this.text(path);
    } catch (err) {
      this.showError(String(err));
      return;
    }
    if (this.conflictPath !== path || this.row !== row) return;
    this.el.view.innerHTML = header + `<div class="diff-body"></div>`;
    if (text.text == null) {
      this.showLines({ placeholder: text.binary ? "Binary file conflict" : "Not a regular file" });
      return;
    }
    const lines = splitLines(text.text);
    const set = fileLines(lines, highlightCached(text, text.text, languageFor(path)));
    // Marker lines (<<<<<<<, %%%%%%%, +++++++, >>>>>>> …) stand out.
    const marker = /^(<{7}|>{7}|%{7}|\+{7}|-{7}|\|{7}|={7}|\\{7})/;
    set.rows = set.rows.map((html, i) => (marker.test(lines[i]) ? html.replace('class="line ctx single"', 'class="line ctx single conflict-marker"') : html));
    this.showLines(set);
    this.el.view.scrollTop = 0;
  }

  /** Fills the view's `.diff-body` with virtually scrolled lines. */
  private showLines(lines: LineSet | { placeholder: string }) {
    const body = this.el.view.querySelector<HTMLElement>(".diff-body");
    if (!body) return;
    if ("placeholder" in lines) {
      this.virtual.unmount();
      body.innerHTML = `<div class="placeholder-text">${escapeHtml(lines.placeholder)}</div>`;
    } else {
      this.virtual.mount(body, lines);
    }
  }

  private async onViewButton(button: HTMLElement) {
    if (button.dataset.action === "resolve-conflict" && this.conflictPath) {
      this.source.openResolve(this.conflictPath, this.diff?.conflicts ?? [this.conflictPath]);
      return;
    }
    if (this.tab === "tree") {
      if (button.dataset.action === "view-diff" && this.diff && this.treePath) {
        const index = this.diff.files.findIndex((f) => f.path === this.treePath);
        if (index >= 0) this.fileIndex = index;
        this.setTab("changes");
      }
      return;
    }
    const file = this.diff?.files[this.fileIndex];
    if (!file) return;
    if (button.dataset.action === "force") {
      this.renderOmitted(file, true);
      return;
    }
    const key = this.key(file.path);
    const expansion = this.expansions.get(key) ?? newExpansion();
    this.expansions.set(key, expansion);
    if (button.dataset.action === "full") {
      expansion.full = !expansion.full;
    } else if (button.dataset.gap !== undefined) {
      expandGap(expansion, Number(button.dataset.gap), button.dataset.dir as "up" | "down" | "all");
    } else {
      return;
    }
    // Expanding needs the file's text, fetched on first use.
    button.setAttribute("disabled", "");
    try {
      const text = await this.text(file.path);
      if (text.text == null) {
        this.showError(text.binary ? "Binary file" : "File too large to expand");
        return;
      }
    } catch (err) {
      this.showError(String(err));
      return;
    }
    this.renderDiff(false);
  }

  private async renderTreeFile(keepScroll = false) {
    const path = this.treePath;
    const row = this.row;
    if (!row || !path) {
      this.el.view.innerHTML = `<div class="placeholder-text">Select a file to view it</div>`;
      return;
    }
    if (this.treeCommit === row.commitId && this.treeIndex() < 0) {
      this.el.view.innerHTML = `<div class="placeholder-text">${escapeHtml(path)} doesn't exist in this commit</div>`;
      return;
    }
    const changed = this.diff?.files.find((f) => f.path === path);
    const header =
      `<div class="diff-header">${changed ? statusBadge(changed.status, changed.conflict) : FILE_ICON}<span class="diff-path">${escapeHtml(path)}</span>` +
      `<span class="header-buttons">${changed ? `<button class="header-button text" data-action="view-diff" title="Show this file's changes in this commit">View changes</button>` : ""}</span></div>`;
    // On a refresh the old file stays up while the new one loads.
    if (!keepScroll) this.el.view.innerHTML = header + `<div class="placeholder-text">Loading…</div>`;
    let text: FileText;
    try {
      text = await this.text(path);
    } catch (err) {
      this.showError(String(err));
      return;
    }
    if (this.treePath !== path || this.row !== row || this.tab !== "tree") return;
    const scrollTop = this.el.view.scrollTop;
    this.el.view.innerHTML = header + `<div class="diff-body"></div>`;
    this.showLines(
      text.text != null
        ? fileLines(splitLines(text.text), highlightCached(text, text.text, languageFor(path)))
        : { placeholder: text.binary ? "Binary file not shown" : text.tooLarge ? "File too large to show" : "Not a regular file" },
    );
    this.el.view.scrollTop = keepScroll ? scrollTop : 0;
  }

  get editing(): boolean {
    return this.editor !== null;
  }

  /** Whether the message being edited differs from where it started. */
  get editDirty(): boolean {
    return this.editor !== null && this.editor.textarea.value !== this.editor.initial;
  }

  /**
   * Edits the shown commit's message in place, on the Commit tab, so the
   * details stay in view; resolves to null if cancelled. Afterwards it goes
   * back to the tab it was on, unless told to stay on the Commit tab.
   */
  editDescription(row: LogRow, initial: string, stayOnCommit = false): Promise<string | null> {
    this.cancelEdit();
    const el = document.createElement("div");
    el.className = "ci-editor";
    el.innerHTML = `<textarea spellcheck="true" rows="8"></textarea>
      <div class="prompt-buttons"><span class="muted prompt-hint">⌥↩ or ⌘↩ to save · Esc to cancel</span><button data-edit="cancel">Cancel</button><button data-edit="save" class="primary">Save</button></div>`;
    const textarea = el.querySelector("textarea")!;
    textarea.value = initial;
    // Save with ⌘↩, or jjui's ⌥↩ / ⌃S; ⌃X clears, as in jjui.
    textarea.addEventListener("keydown", (event) => {
      const save =
        (event.key === "Enter" && (event.metaKey || event.ctrlKey || event.altKey)) ||
        (event.ctrlKey && event.key.toLowerCase() === "s");
      if (save || event.key === "Escape") {
        event.preventDefault();
        // Keep the key from also reaching the graph once the editor closes.
        event.stopPropagation();
        this.finishEdit(save ? textarea.value : null);
      } else if (event.ctrlKey && event.key.toLowerCase() === "x") {
        event.preventDefault();
        textarea.value = "";
      }
    });
    el.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-edit]");
      if (button) this.finishEdit(button.dataset.edit === "save" ? textarea.value : null);
    });
    return new Promise((resolve) => {
      this.editor = { changeId: row.changeId, initial, el, textarea, returnTab: stayOnCommit ? "commit" : this.tab, resolve };
      this.setTab("commit");
      this.renderInfo();
      textarea.focus();
      textarea.setSelectionRange(0, 0);
    });
  }

  cancelEdit() {
    if (this.editor) this.finishEdit(null);
  }

  private finishEdit(value: string | null) {
    const editor = this.editor!;
    this.editor = null;
    if (this.row && !this.compareFrom) this.renderInfo();
    if (this.tab === "commit") this.setTab(editor.returnTab);
    if (editor.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    editor.resolve(value);
  }

  /** The commit header, with the message editor in place of the message while editing. */
  private renderInfo() {
    this.el.info.innerHTML = this.infoHtml(this.row!, this.diff);
    if (this.editor) this.el.info.querySelector(".ci-message")?.replaceWith(this.editor.el);
  }

  private infoHtml(row: LogRow, diff: CommitDiff | null): string {
    const description = diff?.description ?? row.summary;
    const [summary, ...rest] = description.split("\n");
    const body = rest.join("\n").trim();
    const author = diff?.author ?? { name: row.authorName, email: row.authorEmail, timestamp: row.authorTimestamp ?? row.timestamp };
    const committer = diff?.committer;

    let html = `<div class="ci-message">`;
    html += summary
      ? `<div class="ci-summary">${escapeHtml(summary)}</div>`
      : `<div class="ci-summary placeholder">(no description set)</div>`;
    if (body) html += `<div class="ci-body">${escapeHtml(reflowMessage(body))}</div>`;
    html += `</div>`;

    html += `<div class="ci-person">${avatarHtml(author.name, author.email, "large")}
      <div><div><b>${escapeHtml(author.name)}</b>${agentBadge(author.name, author.email)} <span class="muted">&lt;${escapeHtml(author.email)}&gt;</span></div>
      </div></div>`;
    for (const co of row.coauthors) {
      html += `<div class="ci-person coauthor">${avatarHtml(co.name, co.email, "medium")}
        <div><b>${escapeHtml(co.name)}</b>${agentBadge(co.name, co.email)}${co.email ? ` <span class="muted">&lt;${escapeHtml(co.email)}&gt;</span>` : ""}
        <span class="muted">· co-author</span></div></div>`;
    }

    html += `<dl class="ci-meta">`;
    if (committer && (committer.email !== author.email || committer.name !== author.name)) {
      html += `<dt>Committer</dt><dd>${escapeHtml(committer.name)} <span class="muted">&lt;${escapeHtml(committer.email)}&gt;</span></dd>`;
    }
    // Author time is kept through rewrites, so it's roughly when the change began.
    html += `<dt>Created</dt><dd>${escapeHtml(formatFullDate(author.timestamp))}</dd>`;
    html += `<dt>Last changed</dt><dd>${escapeHtml(formatFullDate(committer?.timestamp ?? row.timestamp))}</dd>`;
    html += `<dt>Change</dt><dd class="mono"><span class="id change-id"><b>${row.changeId.slice(0, row.changePrefixLen)}</b>${row.changeId.slice(row.changePrefixLen)}</span></dd>`;
    html += `<dt>Commit</dt><dd class="mono"><span class="id commit-id"><b>${row.commitId.slice(0, row.commitPrefixLen)}</b>${row.commitId.slice(row.commitPrefixLen)}</span></dd>`;
    if (diff && diff.parents.length > 0) {
      html += `<dt>${diff.parents.length > 1 ? "Parents" : "Parent"}</dt><dd>`;
      for (const parent of diff.parents) {
        html += `<div class="ci-parent" data-change="${parent.changeId}" title="Select ${parent.changeId.slice(0, 8)}">
          <span class="id change-id">${parent.changeId.slice(0, 8)}</span>
          <span class="ci-parent-summary">${parent.summary ? escapeHtml(parent.summary) : '<span class="placeholder">(no description set)</span>'}</span></div>`;
      }
      html += `</dd>`;
    }
    html += `</dl>`;
    return html;
  }
}
