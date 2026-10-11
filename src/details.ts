// The panel under the graph, with three views of the selected commit:
// - Commit: details and changed files on the left, the selected diff right.
// - Changes: just the changed files (as a list or a tree) and the diff.
// - File Tree: the whole repository at that commit, with a file viewer.

import {
  type Expansion,
  diffBodyHtml,
  expandGap,
  fileBodyHtml,

  newExpansion,
  splitLines,
} from "./diffview";
import { buildTree, folderPaths, renderTree, type TreeNode } from "./filetree";
import { highlightCached, languageFor, type Segment } from "./highlight";
import { agentBadge, avatarHtml } from "./agents";
import { escapeHtml, formatFullDate, reflowMessage } from "./format";
import type { CommitDiff, FileDiff, FileStatus, FileText, LogRow, TreeEntry } from "./types";

export type DetailsTab = "commit" | "changes" | "tree";
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
  treeFiles(commitId: string): Promise<TreeEntry[]>;
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

  // Changed files.
  private fileIndex = 0;
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

  constructor(
    private el: DetailsElements,
    private source: DetailsSource,
    prefs: { tab?: string | null; changesView?: string | null },
  ) {
    this.tab = (["commit", "changes", "tree"].includes(prefs.tab ?? "") ? prefs.tab : "commit") as DetailsTab;
    this.changesView = prefs.changesView === "tree" ? "tree" : "list";

    el.tabs.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-tab]");
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
      } else if (action === "collapse") {
        this.treeOpen.clear();
        this.renderLeft();
      }
    });
    el.fileList.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      const folder = target.closest<HTMLElement>("[data-folder]");
      if (folder) {
        this.toggleFolder(folder.dataset.folder!);
        return;
      }
      const file = target.closest<HTMLElement>("[data-index]");
      if (file) this.selectItem(Number(file.dataset.index));
    });
    el.info.addEventListener("click", (event) => {
      const parent = (event.target as HTMLElement).closest<HTMLElement>("[data-change]");
      if (parent) source.selectChange(parent.dataset.change!);
    });
    el.view.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("button");
      if (button) this.onViewButton(button);
    });
    this.renderTabs();
  }

  clear(message = "") {
    this.row = null;
    this.diff = null;
    this.el.info.innerHTML = message ? `<div class="placeholder-text">${escapeHtml(message)}</div>` : "";
    this.el.fileHeader.innerHTML = "";
    this.el.fileList.innerHTML = "";
    this.el.view.innerHTML = "";
  }

  /** Shows the row's header straight away, before its diff has loaded. */
  showPending(row: LogRow) {
    if (this.row?.commitId === row.commitId) return;
    this.row = row;
    this.diff = null;
    this.el.info.innerHTML = this.infoHtml(row, null);
    this.renderLeft();
    if (this.tab !== "tree") this.el.view.innerHTML = "";
  }

  show(row: LogRow, diff: CommitDiff) {
    const previousPath = this.diff?.files[this.fileIndex]?.path;
    this.row = row;
    this.diff = diff;
    this.changesTree = buildTree(diff.files.map((f) => f.path));
    this.el.info.innerHTML = this.infoHtml(row, diff);
    const found = previousPath ? diff.files.findIndex((f) => f.path === previousPath) : -1;
    this.fileIndex = found >= 0 ? found : 0;
    this.renderLeft();
    this.renderRight();
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

    if (files.length === 0) {
      // jj diffs a merge against its auto-merged parents, so a clean merge
      // has no changes of its own.
      const message = diff.parents.length > 1 ? "Clean merge: no changes beyond its parents" : "No changes";
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
      this.el.fileList.innerHTML = html;
      this.fileOrder = order;
    } else {
      this.el.fileList.innerHTML = files
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

  private changedFileHtml(file: FileDiff, name: string, dir: string): string {
    const stats = file.binary
      ? `<span class="muted">bin</span>`
      : file.omitted
        ? ""
        : `<span class="add">+${file.additions}</span> <span class="del">−${file.deletions}</span>`;
    const title = file.sourcePath ? `${file.sourcePath} → ${file.path}` : file.path;
    return `${statusBadge(file.status, file.conflict)}<span class="path" title="${escapeHtml(title)}"><span class="name">${escapeHtml(name)}</span>${dir ? `<span class="dir">${escapeHtml(dir)}</span>` : ""}</span><span class="stats">${stats}</span>`;
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
      if (!this.diff || index === this.fileIndex) return;
      this.fileIndex = index;
    }
    for (const el of this.el.fileList.querySelectorAll<HTMLElement>(".tree-row.file")) {
      el.classList.toggle("selected", Number(el.dataset.index) === index);
    }
    this.el.fileList.querySelector(".tree-row.file.selected")?.scrollIntoView({ block: "nearest" });
    this.renderRight();
  }

  // Right side: the diff, or a file from the repository tree.

  private renderRight() {
    if (this.tab === "commit") return;
    if (this.tab === "tree") this.renderTreeFile();
    else this.renderDiff(true);
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
      `<div class="diff-body">${diffBodyHtml(file, expansion, lines, language, highlight)}</div>`;
    this.el.view.scrollTop = resetScroll ? 0 : scrollTop;
    this.el.view.scrollLeft = resetScroll ? 0 : scrollLeft;
  }

  private async onViewButton(button: HTMLElement) {
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

  private async renderTreeFile() {
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
    this.el.view.innerHTML = header + `<div class="placeholder-text">Loading…</div>`;
    let text: FileText;
    try {
      text = await this.text(path);
    } catch (err) {
      this.showError(String(err));
      return;
    }
    if (this.treePath !== path || this.row !== row || this.tab !== "tree") return;
    const body =
      text.text != null
        ? fileBodyHtml(splitLines(text.text), highlightCached(text, text.text, languageFor(path)))
        : `<div class="placeholder-text">${text.binary ? "Binary file not shown" : text.tooLarge ? "File too large to show" : "Not a regular file"}</div>`;
    this.el.view.innerHTML = header + `<div class="diff-body">${body}</div>`;
    this.el.view.scrollTop = 0;
  }

  private infoHtml(row: LogRow, diff: CommitDiff | null): string {
    const description = diff?.description ?? row.summary;
    const [summary, ...rest] = description.split("\n");
    const body = rest.join("\n").trim();
    const author = diff?.author ?? { name: row.authorName, email: row.authorEmail, timestamp: row.timestamp };
    const committer = diff?.committer;

    let html = summary
      ? `<div class="ci-summary">${escapeHtml(summary)}</div>`
      : `<div class="ci-summary placeholder">(no description set)</div>`;
    if (body) html += `<div class="ci-body">${escapeHtml(reflowMessage(body))}</div>`;

    html += `<div class="ci-person">${avatarHtml(author.name, author.email, "large")}
      <div><div><b>${escapeHtml(author.name)}</b>${agentBadge(author.name, author.email)} <span class="muted">&lt;${escapeHtml(author.email)}&gt;</span></div>
      <div class="muted">${escapeHtml(formatFullDate(author.timestamp))}</div></div></div>`;
    for (const co of row.coauthors) {
      html += `<div class="ci-person coauthor">${avatarHtml(co.name, co.email, "medium")}
        <div><b>${escapeHtml(co.name)}</b>${agentBadge(co.name, co.email)}${co.email ? ` <span class="muted">&lt;${escapeHtml(co.email)}&gt;</span>` : ""}
        <span class="muted">· co-author</span></div></div>`;
    }

    html += `<dl class="ci-meta">`;
    if (committer && (committer.email !== author.email || committer.name !== author.name)) {
      html += `<dt>Committer</dt><dd>${escapeHtml(committer.name)} <span class="muted">&lt;${escapeHtml(committer.email)}&gt;</span></dd>`;
    }
    if (committer && committer.timestamp !== author.timestamp) {
      html += `<dt>Committed</dt><dd>${escapeHtml(formatFullDate(committer.timestamp))}</dd>`;
    }
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
