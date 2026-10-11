// Resolving a commit's conflicts, as a takeover of the workspace like the
// operation log: the conflicted files down the left, the merge editor for the
// selected one on the right. Each resolution rewrites the commit, so after
// every file the view follows the change to its new commit.

import { storage } from "./api";
import { escapeHtml } from "./format";
import { type ConflictFile, MergeEditor, type MergeLayout } from "./mergeview";
import type { LogRow } from "./types";

export interface ResolveCallbacks {
  loadConflict(commitId: string, path: string): Promise<ConflictFile>;
  /** Writes a resolution, then calls `update` with the rewritten commit. */
  resolve(path: string, content: string): void;
  takeSide(path: string, side: "ours" | "theirs"): void;
  close(): void;
}

export class ResolveView {
  private row: LogRow | null = null;
  private conflicts: string[] = [];
  private resolved: string[] = [];
  private current: string | null = null;
  private editor: MergeEditor | null = null;
  private list: HTMLElement;
  private pane: HTMLElement;
  private title: HTMLElement;

  constructor(
    private el: HTMLElement,
    private callbacks: ResolveCallbacks,
  ) {
    el.innerHTML = `<div class="takeover-card resolve-card">
        <div class="takeover-header"><span class="takeover-title"></span>
          <button class="header-button oplog-close" data-action="close" title="Close (Esc)"><svg viewBox="0 0 10 10" width="10" height="10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>
        <div class="resolve-body"><div class="resolve-files"></div><div class="resolve-pane"></div></div>
      </div>`;
    this.list = el.querySelector(".resolve-files")!;
    this.pane = el.querySelector(".resolve-pane")!;
    this.title = el.querySelector(".takeover-title")!;
    el.querySelector("[data-action='close']")!.addEventListener("click", () => callbacks.close());
    this.list.addEventListener("mousedown", (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>("[data-path]");
      if (item && this.conflicts.includes(item.dataset.path!)) this.select(item.dataset.path!);
    });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  open(row: LogRow, conflicts: string[], path: string) {
    this.el.hidden = false;
    this.resolved = [];
    this.update(row, conflicts, path);
  }

  hide() {
    this.el.hidden = true;
    this.editor = null;
    this.pane.innerHTML = "";
  }

  /** After a resolution: the rewritten commit and what's still conflicted. */
  update(row: LogRow, conflicts: string[], next?: string, justResolved?: string) {
    if (justResolved && !this.resolved.includes(justResolved)) this.resolved.push(justResolved);
    this.row = row;
    this.conflicts = conflicts;
    this.title.innerHTML =
      `Resolve conflicts <span class="id change-id">${row.changeId.slice(0, 8)}</span> ` +
      `<span class="muted">${escapeHtml(row.summary || "(no description set)")}</span>`;
    this.renderList();
    const target = next && conflicts.includes(next) ? next : conflicts[0];
    if (target) this.select(target);
  }

  jump(delta: 1 | -1) {
    this.editor?.jump(delta);
  }

  private renderList() {
    const all = [...this.conflicts, ...this.resolved.filter((p) => !this.conflicts.includes(p))];
    this.list.innerHTML =
      `<div class="list-section">${this.conflicts.length} ${this.conflicts.length === 1 ? "file" : "files"} to resolve</div>` +
      all
        .map((path) => {
          const done = !this.conflicts.includes(path);
          const slash = path.lastIndexOf("/");
          return `<div class="tree-row file${path === this.current ? " selected" : ""}${done ? " done" : ""}" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">
            <span class="status ${done ? "added" : "modified conflict"}">${done ? "✓" : "!"}</span>
            <span class="path"><span class="name">${escapeHtml(path.slice(slash + 1))}</span>${slash >= 0 ? `<span class="dir">${escapeHtml(path.slice(0, slash + 1))}</span>` : ""}</span></div>`;
        })
        .join("");
  }

  private async select(path: string) {
    const row = this.row!;
    this.current = path;
    this.renderList();
    this.editor = null;
    this.pane.innerHTML = `<div class="placeholder-text">Loading conflict…</div>`;
    let file: ConflictFile;
    try {
      file = await this.callbacks.loadConflict(row.commitId, path);
    } catch (err) {
      this.pane.innerHTML = `<div class="placeholder-text error-text">${escapeHtml(String(err))}</div>`;
      return;
    }
    if (this.current !== path || this.row !== row) return;
    if (!file.supported) {
      this.pane.innerHTML = `<div class="placeholder-text">This conflict has more than two sides or isn't a text file, so it can't be merged here.
        <div class="merge-fallback"><button class="header-button text" data-side="ours">Take All of Side 1</button><button class="header-button text" data-side="theirs">Take All of Side 2</button></div></div>`;
      this.pane.querySelectorAll<HTMLElement>("[data-side]").forEach((b) =>
        b.addEventListener("click", () => this.callbacks.takeSide(path, b.dataset.side as "ours" | "theirs")),
      );
      return;
    }
    const layout = (storage("mergeLayout") as MergeLayout | null) ?? "columns";
    this.editor = new MergeEditor(this.pane, path, file, layout, {
      resolve: (content) => this.callbacks.resolve(path, content),
      takeSide: (side) => this.callbacks.takeSide(path, side),
      cancel: () => this.callbacks.close(),
      layoutChanged: (next) => storage("mergeLayout", next),
    });
  }
}
