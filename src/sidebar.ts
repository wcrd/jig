// The sidebar: workspaces, bookmarks, remotes and tags, with bookmarks shown
// as folders split on "/" or as a flat list.

import { storage } from "./api";
import { buildTree, renderTree } from "./filetree";
import { escapeHtml, remoteLabel } from "./format";
import type { Sidebar as SidebarData, SidebarBookmark } from "./types";

type Section = "workspaces" | "bookmarks" | "remotes" | "tags";

/** One clickable entry; `commitId` is where it points, if anywhere. */
export interface SidebarItem {
  kind: "workspace" | "bookmark" | "remote" | "tag" | "remoteRoot";
  name: string;
  remote?: string;
  commitId: string | null;
  bookmark?: SidebarBookmark;
  tracked?: boolean;
  /** For a remote itself: its fetch URL. */
  url?: string | null;
  /** For a workspace: its folder, if known. */
  path?: string | null;
}

export interface SidebarCallbacks {
  select(item: SidebarItem): void;
  contextMenu(item: SidebarItem): void;
  addWorkspace(): void;
}

const ICONS = {
  workspace: `<svg viewBox="0 0 16 16" width="13" height="13"><rect x="2" y="3" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 14h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  bookmark: `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4.5 2.5h7v11L8 10.8l-3.5 2.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  remote: `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4.5 12.5h7a3 3 0 0 0 .4-6 4 4 0 0 0-7.7.9A2.6 2.6 0 0 0 4.5 12.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  tag: `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M2.5 2.5h5.2l6 6-5.2 5.2-6-6zM5.3 5.3h.01" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
  remoteRoot: "",
};
ICONS.remoteRoot = ICONS.remote;
const LINK_ICON = `<svg viewBox="0 0 16 16" width="11" height="11"><path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const LIST_ICON = `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const TREE_ICON = `<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 3.5h5M6 8h7M6 12.5h7M4 4v8.5h2M4 8h2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PLUS_ICON = `<svg viewBox="0 0 16 16" width="11" height="11"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const CHEVRON = `<svg class="chevron" viewBox="0 0 10 10" width="9" height="9"><path d="M3 2l3.5 3L3 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export class Sidebar {
  private data: SidebarData | null = null;
  private items: SidebarItem[] = [];
  private flat = storage("sidebarFlat") === "1";
  private filter = "";
  private collapsedSections = new Set<string>(JSON.parse(storage("sidebarCollapsed") ?? '["tags"]'));
  /** Collapsed folders, keyed by section. */
  private collapsedFolders = new Set<string>();
  private selectedCommit: string | null = null;
  private list: HTMLElement;
  private filterInput: HTMLInputElement;

  constructor(
    private el: HTMLElement,
    callbacks: SidebarCallbacks,
  ) {
    el.innerHTML = `<div class="sidebar-title" data-ref="repo-name"></div><div class="sidebar-header">
        <input class="sidebar-filter" placeholder="Filter" spellcheck="false" autocomplete="off" />
        <button class="header-button" data-view="tree" title="Group bookmarks into folders">${TREE_ICON}</button>
        <button class="header-button" data-view="flat" title="Show bookmarks as a flat list">${LIST_ICON}</button>
      </div><div class="sidebar-list"></div>`;
    this.list = el.querySelector(".sidebar-list")!;
    this.filterInput = el.querySelector(".sidebar-filter")!;
    this.filterInput.addEventListener("input", () => {
      this.filter = this.filterInput.value.trim().toLowerCase();
      this.render();
    });
    el.querySelector(".sidebar-header")!.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-view]");
      if (!button) return;
      this.flat = button.dataset.view === "flat";
      storage("sidebarFlat", this.flat ? "1" : "0");
      this.render();
    });
    this.list.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-add-workspace]")) return callbacks.addWorkspace();
      const section = target.closest<HTMLElement>("[data-section-toggle]");
      if (section) return this.toggleSection(section.dataset.sectionToggle!);
      const folder = target.closest<HTMLElement>("[data-folder]");
      if (folder) return this.toggleFolder(folder.dataset.folder!);
      const item = target.closest<HTMLElement>("[data-item]");
      if (item) callbacks.select(this.items[Number(item.dataset.item)]);
    });
    this.list.addEventListener("contextmenu", (event) => {
      const target = event.target as HTMLElement;
      const item = target.closest<HTMLElement>("[data-item]") ?? target.closest<HTMLElement>("[data-item-menu]");
      if (!item) return;
      event.preventDefault();
      callbacks.contextMenu(this.items[Number(item.dataset.item ?? item.dataset.itemMenu)]);
    });
  }

  setData(data: SidebarData) {
    this.data = data;
    this.render();
  }

  /** Highlights entries pointing at the selected commit. */
  setSelectedCommit(commitId: string | null) {
    if (commitId === this.selectedCommit) return;
    this.selectedCommit = commitId;
    for (const el of this.list.querySelectorAll<HTMLElement>("[data-item]")) {
      el.classList.toggle("selected", !!commitId && this.items[Number(el.dataset.item)].commitId === commitId);
    }
  }

  private toggleSection(section: string) {
    if (this.collapsedSections.has(section)) this.collapsedSections.delete(section);
    else this.collapsedSections.add(section);
    storage("sidebarCollapsed", JSON.stringify([...this.collapsedSections]));
    this.render();
  }

  private toggleFolder(key: string) {
    if (this.collapsedFolders.has(key)) this.collapsedFolders.delete(key);
    else this.collapsedFolders.add(key);
    this.render();
  }

  private render() {
    for (const button of this.el.querySelectorAll<HTMLElement>("[data-view]")) {
      button.classList.toggle("active", (button.dataset.view === "flat") === this.flat);
    }
    const data = this.data;
    if (!data) {
      this.list.innerHTML = "";
      return;
    }
    this.items = [];
    const matches = (name: string) => !this.filter || name.toLowerCase().includes(this.filter);

    const workspaces: SidebarItem[] = data.workspaces
      .filter((w) => matches(w.name))
      .map((w) => ({ kind: "workspace", name: w.name, commitId: w.commitId, tracked: w.current, path: w.path }));
    const bookmarks: SidebarItem[] = data.bookmarks
      .filter((b) => b.commitId && matches(b.name))
      .map((b) => ({ kind: "bookmark", name: b.name, commitId: b.commitId, bookmark: b }));
    const tags: SidebarItem[] = data.tags
      .filter((t) => matches(t.name))
      .map((t) => ({ kind: "tag", name: t.name, commitId: t.commitId }));
    const remotes = new Map<string, SidebarItem[]>();
    for (const remote of data.remotes ?? []) remotes.set(remote.name, []);
    for (const b of data.bookmarks) {
      for (const r of b.remotes) {
        if (!matches(`${b.name}@${r.remote}`)) continue;
        if (!remotes.has(r.remote)) remotes.set(r.remote, []);
        remotes.get(r.remote)!.push({
          kind: "remote",
          name: b.name,
          remote: r.remote,
          commitId: r.commitId,
          tracked: r.tracked,
          bookmark: b,
        });
      }
    }
    const urls = new Map((data.remotes ?? []).map((r) => [r.name, r.url]));
    let html = "";
    html += this.section("workspaces", "Workspaces", workspaces.length, () => this.flatRows(workspaces, 0));
    html += this.section("bookmarks", "Bookmarks", bookmarks.length, () => this.itemRows("bookmarks", bookmarks, 0));
    const remoteCount = [...remotes.values()].reduce((n, r) => n + r.length, 0);
    html += this.section("remotes", "Remotes", remoteCount, () =>
      [...remotes.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([remote, items]) => {
          const key = `remotes:${remote}`;
          const open = this.filter !== "" || !this.collapsedFolders.has(key);
          const url = urls.get(remote) ?? null;
          const index = this.items.push({ kind: "remoteRoot", name: remote, remote, commitId: null, url }) - 1;
          return (
            `<div class="tree-row folder remote-root${open ? " open" : ""}" data-folder="${escapeHtml(key)}" data-item-menu="${index}" style="padding-left:10px" title="${escapeHtml(url ?? remote)}">${CHEVRON}${ICONS.remote}<span class="name">${escapeHtml(remote)}</span><span class="remote-host">${escapeHtml(remoteLabel(url))}</span></div>` +
            (open ? this.itemRows(`remotes:${remote}`, items, 1) : "")
          );
        })
        .join(""),
    );
    html += this.section("tags", "Tags", tags.length, () => this.itemRows("tags", tags, 0));
    this.list.innerHTML = html;
    // Re-apply the highlight to the new rows.
    const selected = this.selectedCommit;
    this.selectedCommit = null;
    this.setSelectedCommit(selected);
  }

  private section(id: Section, title: string, count: number, body: () => string): string {
    if (count === 0 && this.filter) return "";
    const open = this.filter !== "" || !this.collapsedSections.has(id);
    const add = id === "workspaces" ? `<button class="section-add" data-add-workspace title="Add Workspace…">${PLUS_ICON}</button>` : "";
    return (
      `<div class="sidebar-section${open ? " open" : ""}" data-section-toggle="${id}">${CHEVRON}<span>${title}</span><span class="count">${count}</span>${add}</div>` +
      (open ? body() : "")
    );
  }

  /** Rows for bookmarks or tags: folders split on "/" unless flat. */
  private itemRows(section: string, items: SidebarItem[], depth: number): string {
    if (this.flat || this.filter) return this.flatRows(items, depth);
    const root = buildTree(items.map((i) => i.name));
    const collapsed = new Set(
      [...this.collapsedFolders].filter((k) => k.startsWith(`${section}/`)).map((k) => k.slice(section.length + 1)),
    );
    const { html } = renderTree(root, {
      collapsed,
      selected: -1,
      fileHtml: (i, node) => this.itemContent(items[i], node.name),
    });
    // Tree rows refer to positions in `items`; rewrite them to global indices
    // and namespace folder keys by section.
    const base = this.items.length;
    this.items.push(...items);
    return html
      .replace(/data-index="(\d+)"/g, (_, i) => `data-item="${base + Number(i)}"`)
      .replace(/data-folder="([^"]*)"/g, (_, f) => `data-folder="${section}/${f}"`)
      .replace(/padding-left:(\d+)px/g, (_, px) => `padding-left:${Number(px) + depth * 14}px`)
      .replace(/class="tree-row file"/g, 'class="tree-row file sidebar-item"');
  }

  private flatRows(items: SidebarItem[], depth: number): string {
    return items
      .map((item) => {
        const index = this.items.push(item) - 1;
        const title = item.path ? ` title="${escapeHtml(item.path)}"` : "";
        return `<div class="tree-row file sidebar-item" data-item="${index}" style="padding-left:${24 + depth * 14}px"${title}>${this.itemContent(item, item.name)}</div>`;
      })
      .join("");
  }

  private itemContent(item: SidebarItem, label: string): string {
    let flags = "";
    if (item.kind === "bookmark" && item.bookmark) {
      const differing = item.bookmark.remotes.find((r) => r.tracked && (r.ahead || r.behind));
      if (item.bookmark.conflict) flags += `<span class="flag conflict" title="Conflicted">??</span>`;
      else if (differing) {
        const counts = (differing.ahead ? `↑${differing.ahead}` : "") + (differing.behind ? `↓${differing.behind}` : "");
        const title = [differing.ahead && `${differing.ahead} ahead of ${differing.remote}`, differing.behind && `${differing.behind} behind ${differing.remote}`].filter(Boolean).join(", ");
        flags += `<span class="flag" title="${title}">${counts}</span>`;
      } else if (item.bookmark.tracked && !item.bookmark.synced) flags += `<span class="flag" title="Differs from its remote">*</span>`;
    }
    if (item.kind === "remote") {
      flags += item.tracked
        ? `<span class="flag tracked" title="Tracked: the local bookmark follows this on fetch, and pushes update it. Right-click to untrack.">${LINK_ICON}</span>`
        : `<span class="flag muted" title="Not tracked: fetching won't create or move a local bookmark. Right-click to track it.">untracked</span>`;
    }
    const current = item.kind === "workspace" && item.tracked ? " current" : "";
    return `${ICONS[item.kind]}<span class="path${current}"><span class="name">${escapeHtml(label)}</span></span>${flags}`;
  }
}
