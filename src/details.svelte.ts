// The panel under the graph, with three views of the selected commit:
// - Commit: details and changed files on the left, the selected diff right.
// - Changes: just the changed files (as a list or a tree) and the diff.
// - File Tree: the whole repository at that commit, with a file viewer.
//
// The state lives here and Details.svelte draws it, except for the diff or
// file on the right: that's drawn directly into its element, with only the
// visible lines in the DOM, so huge files stay fast.

import { tick } from "svelte";
import { SvelteMap, SvelteSet } from "svelte/reactivity";

import {
  type Expansion,
  diffLines,
  expandGap,
  fileLines,
  newExpansion,
  type SplitTicks,
  splitLines,
} from "./diffview";
import { buildTree, folderPaths, treeLines, type TreeNode, type TreeRow } from "./filetree";
import { highlightCached, languageFor, type Segment } from "./highlight";
import { type Html, html, raw, setHtml } from "./html";
import { FILE } from "./icons";
import type { SearchTarget } from "./search.svelte";
import type { CommitDiff, CompareDiff, FileDiff, FileStatus, FileText, LogRow, TreeEntry } from "./types";
import { type LineSet, VirtualLines } from "./virtual";

export type DetailsTab = "commit" | "changes" | "tree";
export type ChangesView = "list" | "tree";

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

export const STATUS_LETTER: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

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

/** The commit message being edited in place of the shown one. */
export interface MessageEditor {
  changeId: string;
  initial: string;
  /** Set once the editor is drawn. */
  el: HTMLElement | null;
  textarea: HTMLTextAreaElement | null;
  returnTab: DetailsTab;
  resolve: (value: string | null) => void;
}

const FILE_ICON = raw(FILE);

function statusBadge(status: FileStatus, conflict = false): Html {
  return html`<span class="status ${status}${conflict ? " conflict" : ""}">${conflict ? "!" : STATUS_LETTER[status]}</span>`;
}

export class DetailsPanel {
  tab = $state<DetailsTab>("commit");
  changesView = $state<ChangesView>("list");
  row = $state.raw<LogRow | null>(null);
  diff = $state.raw<CommitDiff | null>(null);
  /** Bumped when a file in `diff` is replaced in place (an omitted file, loaded). */
  filesVersion = $state(0);
  /** In compare mode, the commit compared from; `row` is the one compared to. */
  compareFrom = $state.raw<LogRow | null>(null);
  /** Shown in place of the commit when there's none. */
  message = $state("");

  // Changed files.
  fileIndex = $state(0);
  /** A conflicted file being viewed instead of a diff. */
  conflictPath = $state<string | null>(null);
  changesCollapsed = new SvelteSet<string>();
  changesTree = $state.raw<TreeNode | null>(null);

  // Repository browser.
  treeCommit = $state<string | null>(null);
  treeEntries = $state.raw<TreeEntry[]>([]);
  treeRoot = $state.raw<TreeNode | null>(null);
  /** Loading the tree for `row`, or why that failed. */
  treeLoad = $state.raw<{ state: "loading" } | { state: "error"; message: string } | null>(null);
  /** Folders are collapsed in the browser unless opened. */
  treeOpen = new SvelteSet<string>();
  treePath = $state<string | null>(null);
  /** A folder the arrow keys have moved onto, in either tree. */
  focusedFolder = $state<string | null>(null);

  /**
   * In split mode, what's ticked for the first commit, by path: every change
   * in the file, or some of its lines. Unlisted files stay in the second.
   */
  split = $state.raw<SvelteMap<string, "all" | SplitLines> | null>(null);
  /** The last line ticked or unticked, for shift-click ranges. */
  private splitAnchor: { path: string; hunk: number; line: number; on: boolean } | null = null;

  editor = $state.raw<MessageEditor | null>(null);

  // Expanded diff context and file text, by commit and path.
  private expansions = new Map<string, Expansion>();
  private texts = new Map<string, Promise<FileText>>();

  /** The diff or file on the right, drawn directly; set by `attach`. */
  private view!: HTMLElement;
  private fileList!: HTMLElement;
  /** Draws only the visible lines of large diffs and files. */
  private virtual!: VirtualLines;

  constructor(
    readonly source: DetailsSource,
    prefs: { tab?: string | null; changesView?: string | null },
  ) {
    this.tab = (["commit", "changes", "tree"].includes(prefs.tab ?? "") ? prefs.tab : "commit") as DetailsTab;
    this.changesView = prefs.changesView === "tree" ? "tree" : "list";
  }

  /** Takes the elements Details.svelte drew: the view for the diff or file, and the file list. */
  attach(view: HTMLElement, fileList: HTMLElement) {
    this.view = view;
    this.fileList = fileList;
    this.virtual = new VirtualLines(this.view);

    this.view.addEventListener("mousedown", (event) => {
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
    this.view.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("button");
      if (button) this.onViewButton(button);
    });
  }

  /** Find (⌘F) in the shown diff or file. */
  get searchTarget(): SearchTarget {
    return this.virtual;
  }

  clear(message = "") {
    this.cancelEdit();
    this.row = null;
    this.diff = null;
    this.message = message;
    this.view.replaceChildren();
  }

  /** Shows the row's header straight away, before its diff has loaded. */
  showPending(row: LogRow) {
    if (this.row?.commitId === row.commitId && !this.compareFrom) return;
    if (this.editor && this.editor.changeId !== row.changeId) this.cancelEdit();
    this.compareFrom = null;
    this.row = row;
    this.diff = null;
    this.renderLeft();
    if (this.tab !== "tree") this.view.replaceChildren();
  }

  /** `refresh`: the repo reloaded, so keep scroll positions where the content allows. */
  show(row: LogRow, diff: CommitDiff, refresh = false) {
    // The same commit has the same diff; only its refs may have changed.
    if (refresh && !this.compareFrom && this.diff && this.row?.commitId === row.commitId) {
      this.row = row;
      return;
    }
    const previousPath = this.diff?.files[this.fileIndex]?.path;
    if (this.split && this.row?.commitId !== row.commitId) this.split = new SvelteMap();
    if (this.editor && this.editor.changeId !== row.changeId) this.cancelEdit();
    this.compareFrom = null;
    this.focusedFolder = null;
    this.row = row;
    this.diff = diff;
    this.changesTree = buildTree(diff.files.map((f) => f.path));
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
    this.renderLeft();
    if (this.tab !== "tree") this.view.replaceChildren();
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
    this.focusedFolder = null;
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
    const found = previousPath ? compare.files.findIndex((f) => f.path === previousPath) : -1;
    this.fileIndex = found >= 0 ? found : 0;
    this.rerender(refresh && found >= 0);
  }

  /** Redraws both sides for a new diff, keeping the scroll positions if asked. */
  private rerender(keepScroll: boolean) {
    const listScroll = this.fileList.scrollTop;
    this.renderLeft();
    if (keepScroll) tick().then(() => (this.fileList.scrollTop = listScroll));
    this.renderRight(keepScroll);
  }

  startSplit() {
    this.split = new SvelteMap();
    this.splitAnchor = null;
    if (this.tab !== "changes") this.setTab("changes");
    else this.renderRight();
  }

  endSplit() {
    if (!this.split) return;
    this.split = null;
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

  fileSplitState(file: FileDiff): "none" | "some" | "all" {
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

  toggleSplitFile(index: number) {
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
    this.renderDiff(false);
    this.source.splitChanged();
  }

  showError(message: string) {
    setHtml(this.view, html`<div class="placeholder-text error-text">${message}</div>`);
  }

  /** The visible rows of the changed files or the repository tree, in order. */
  private rows(): TreeRow[] {
    if (this.tab === "tree") {
      return this.treeRoot ? treeLines(this.treeRoot, this.treeCollapsed()) : [];
    }
    if (!this.diff || this.diff.files.length === 0) return [];
    if (this.changesView === "tree") return treeLines(this.changesTree!, this.changesCollapsed);
    return this.diff.files.map((_, i) => ({ item: i }));
  }

  /** Folders in the repository browser that aren't open. */
  treeCollapsed(): Set<string> {
    return new Set(folderPaths(this.treeRoot!).filter((p) => !this.treeOpen.has(p)));
  }

  /** Moves the selection through files and folders, for keyboard navigation. */
  moveFile(delta: number) {
    const rows = this.rows();
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => this.isCurrentRow(r));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + delta))];
    if ("folder" in next) {
      this.focusedFolder = next.folder;
      this.revealSelection();
    } else {
      this.selectItem(next.item);
    }
  }

  /**
   * ← / → on a focused folder: ← collapses it, or steps to its parent once
   * closed; → expands it, or steps into it once open. Returns whether the
   * key was used.
   */
  folderKey(expand: boolean) {
    const path = this.focusedFolder;
    if (path === null) return false;
    const open = this.tab === "tree" ? this.treeOpen.has(path) : !this.changesCollapsed.has(path);
    if (open !== expand) {
      this.toggleFolder(path);
    } else if (expand) {
      this.moveFile(1);
    } else {
      const rows = this.rows();
      const at = rows.findIndex((r) => this.isCurrentRow(r));
      for (let i = at - 1; i >= 0; i--) {
        const row = rows[i];
        if ("folder" in row && path.startsWith(`${row.folder}/`)) {
          this.focusedFolder = row.folder;
          this.revealSelection();
          break;
        }
      }
    }
    return true;
  }

  /** Whether a row is the focused folder, or else the selected file. */
  isCurrentRow(row: TreeRow): boolean {
    if ("folder" in row) return row.folder === this.focusedFolder;
    return this.focusedFolder === null && row.item === (this.tab === "tree" ? this.treeIndex() : this.fileIndex);
  }

  /** Scrolls the highlighted row into view once it's drawn. */
  private async revealSelection() {
    await tick();
    this.fileList.querySelector(".tree-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  get currentTab(): DetailsTab {
    return this.tab;
  }

  setTab(tab: DetailsTab) {
    if (tab === this.tab) return;
    this.tab = tab;
    this.focusedFolder = null;
    this.source.save("detailsTab", tab);
    this.renderLeft();
    this.renderRight();
  }

  setChangesView(view: ChangesView) {
    this.changesView = view;
    this.focusedFolder = null;
    this.source.save("changesView", view);
  }

  // Left side: changed files or the repository tree. They draw themselves;
  // the repository tree needs loading for each commit first.

  private renderLeft() {
    if (this.tab === "tree") this.loadTree();
  }

  private async loadTree() {
    const row = this.row;
    if (!row || this.treeCommit === row.commitId) return;
    this.treeLoad = { state: "loading" };
    let entries: TreeEntry[];
    try {
      entries = await this.source.treeFiles(row.commitId);
    } catch (err) {
      if (this.row === row) this.treeLoad = { state: "error", message: String(err) };
      return;
    }
    // The selection may have moved on while loading.
    if (this.row?.commitId !== row.commitId || this.tab !== "tree") return;
    this.treeCommit = row.commitId;
    this.treeEntries = entries;
    this.treeRoot = buildTree(entries.map((e) => e.path));
    this.treeLoad = null;
    // Open the folders leading to the selected file.
    if (this.treePath) {
      const parts = this.treePath.split("/");
      for (let i = 1; i < parts.length; i++) this.treeOpen.add(parts.slice(0, i).join("/"));
    }
    this.renderRight();
  }

  treeIndex(): number {
    if (!this.treePath) return -1;
    return this.treeEntries.findIndex((e) => e.path === this.treePath);
  }

  toggleFolder(path: string) {
    if (this.tab === "tree") {
      if (this.treeOpen.has(path)) this.treeOpen.delete(path);
      else this.treeOpen.add(path);
    } else if (this.changesCollapsed.has(path)) {
      this.changesCollapsed.delete(path);
    } else {
      this.changesCollapsed.add(path);
    }
  }

  collapseTree() {
    this.treeOpen.clear();
  }

  /** Shows a conflicted file in place of a diff. */
  showConflict(path: string) {
    this.conflictPath = path;
    if (this.tab === "commit") this.setTab("changes");
    else this.renderRight();
  }

  selectItem(index: number) {
    if (this.focusedFolder !== null) this.focusedFolder = null;
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
      this.conflictPath = null;
    }
    this.revealSelection();
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
      this.view.replaceChildren();
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
    const fullButton =
      canExpand &&
      html`<button class="header-button text${expansion.full ? " active" : ""}" data-action="full" title="Show the whole file">Full file</button>`;
    const rename = file.sourcePath && html`<span class="muted">${file.sourcePath} → </span>`;
    const conflict = file.conflict && html`<span class="pill flag conflict"><span class="label">conflict</span></span>`;
    const scrollTop = this.view.scrollTop;
    const scrollLeft = this.view.scrollLeft;
    setHtml(
      this.view,
      html`<div class="diff-header">${statusBadge(file.status, file.conflict)}<span class="diff-path">${rename}${file.path}</span>${conflict}<span class="header-buttons">${fullButton}</span></div>`,
      html`<div class="diff-body"></div>`,
    );
    const state = this.split?.get(file.path);
    const ticked: SplitTicks | null = this.split
      ? {
          hunk: (g) => this.hunkSplitState(file, g),
          line: (g, i) => state === "all" || !!state?.get(g)?.has(i),
        }
      : null;
    this.showLines(diffLines(file, expansion, lines, language, highlight, ticked));
    this.view.scrollTop = resetScroll ? 0 : scrollTop;
    this.view.scrollLeft = resetScroll ? 0 : scrollLeft;
  }

  /**
   * A file left out of the commit's diff: load it now, unless it's over the
   * size limit, in which case offer to.
   */
  private async renderOmitted(file: FileDiff, force = false) {
    const header = html`<div class="diff-header">${statusBadge(file.status, file.conflict)}<span class="diff-path">${file.path}</span></div>`;
    this.virtual.unmount();
    if (file.tooLarge && !force) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      const button = html`<button class="header-button text load-anyway" data-action="force">Show Diff Anyway</button>`;
      setHtml(
        this.view,
        header,
        html`<div class="placeholder-text">This file is ${mb} MB, so it wasn't diffed automatically; large files can take a while.<div>${button}</div></div>`,
      );
      return;
    }
    setHtml(this.view, header, html`<div class="placeholder-text">Loading diff…</div>`);
    const diff = this.diff;
    const index = this.fileIndex;
    try {
      const loaded = await this.source.fileDiff(this.compareFrom?.commitId ?? null, this.row!.commitId, file, force);
      // Store it in place so the cached commit diff keeps it.
      if (diff?.files[index] === file) {
        diff.files[index] = loaded;
        this.filesVersion++;
      }
    } catch (err) {
      if (this.diff === diff && this.fileIndex === index) this.showError(String(err));
      return;
    }
    if (this.diff !== diff || this.fileIndex !== index || this.tab === "tree") return;
    this.renderDiff(true);
  }

  /** A conflicted file, with jj's conflict markers highlighted. */
  private async renderConflict(path: string) {
    const row = this.row;
    this.virtual.unmount();
    const resolve =
      !this.compareFrom &&
      html`<span class="header-buttons"><button class="header-button text primary" data-action="resolve-conflict">Resolve…</button></span>`;
    const header = html`<div class="diff-header"><span class="status modified conflict">!</span><span class="diff-path">${path}</span><span class="pill flag conflict"><span class="label">unresolved conflict</span></span>${resolve}</div>`;
    setHtml(this.view, header, html`<div class="placeholder-text">Loading…</div>`);
    let text: FileText;
    try {
      text = await this.text(path);
    } catch (err) {
      this.showError(String(err));
      return;
    }
    if (this.conflictPath !== path || this.row !== row) return;
    setHtml(this.view, header, html`<div class="diff-body"></div>`);
    if (text.text == null) {
      this.showLines({ placeholder: text.binary ? "Binary file conflict" : "Not a regular file" });
      return;
    }
    const lines = splitLines(text.text);
    const set = fileLines(lines, highlightCached(text, text.text, languageFor(path)));
    // Marker lines (<<<<<<<, %%%%%%%, +++++++, >>>>>>> …) stand out.
    const marker = /^(<{7}|>{7}|%{7}|\+{7}|-{7}|\|{7}|={7}|\\{7})/;
    set.rows = set.rows.map((row, i) => (marker.test(lines[i]) ? row.replace('class="line ctx single"', 'class="line ctx single conflict-marker"') : row));
    this.showLines(set);
    this.view.scrollTop = 0;
  }

  /** Fills the view's `.diff-body` with virtually scrolled lines. */
  private showLines(lines: LineSet | { placeholder: string }) {
    const body = this.view.querySelector<HTMLElement>(".diff-body");
    if (!body) return;
    if ("placeholder" in lines) {
      this.virtual.unmount();
      setHtml(body, html`<div class="placeholder-text">${lines.placeholder}</div>`);
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
      setHtml(this.view, html`<div class="placeholder-text">Select a file to view it</div>`);
      return;
    }
    if (this.treeCommit === row.commitId && this.treeIndex() < 0) {
      setHtml(this.view, html`<div class="placeholder-text">${path} doesn't exist in this commit</div>`);
      return;
    }
    const changed = this.diff?.files.find((f) => f.path === path);
    const viewChanges =
      changed &&
      html`<button class="header-button text" data-action="view-diff" title="Show this file's changes in this commit">View changes</button>`;
    const header = html`<div class="diff-header">${changed ? statusBadge(changed.status, changed.conflict) : FILE_ICON}<span class="diff-path">${path}</span><span class="header-buttons">${viewChanges}</span></div>`;
    // On a refresh the old file stays up while the new one loads.
    if (!keepScroll) setHtml(this.view, header, html`<div class="placeholder-text">Loading…</div>`);
    let text: FileText;
    try {
      text = await this.text(path);
    } catch (err) {
      this.showError(String(err));
      return;
    }
    if (this.treePath !== path || this.row !== row || this.tab !== "tree") return;
    const scrollTop = this.view.scrollTop;
    setHtml(this.view, header, html`<div class="diff-body"></div>`);
    this.showLines(
      text.text != null
        ? fileLines(splitLines(text.text), highlightCached(text, text.text, languageFor(path)))
        : { placeholder: text.binary ? "Binary file not shown" : text.tooLarge ? "File too large to show" : "Not a regular file" },
    );
    this.view.scrollTop = keepScroll ? scrollTop : 0;
  }

  get editing(): boolean {
    return this.editor !== null;
  }

  /** Whether the message being edited differs from where it started. */
  get editDirty(): boolean {
    return !!this.editor?.textarea && this.editor.textarea.value !== this.editor.initial;
  }

  /**
   * Edits the shown commit's message in place, on the Commit tab, so the
   * details stay in view; resolves to null if cancelled. Afterwards it goes
   * back to the tab it was on, unless told to stay on the Commit tab.
   */
  editDescription(row: LogRow, initial: string, stayOnCommit = false): Promise<string | null> {
    this.cancelEdit();
    return new Promise((resolve) => {
      this.editor = { changeId: row.changeId, initial, el: null, textarea: null, returnTab: stayOnCommit ? "commit" : this.tab, resolve };
      this.setTab("commit");
      tick().then(() => {
        const textarea = this.editor?.textarea;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(0, 0);
      });
    });
  }

  cancelEdit() {
    if (this.editor) this.finishEdit(null);
  }

  finishEdit(value: string | null) {
    const editor = this.editor!;
    this.editor = null;
    if (this.tab === "commit") this.setTab(editor.returnTab);
    if (editor.el?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    editor.resolve(value);
  }
}
