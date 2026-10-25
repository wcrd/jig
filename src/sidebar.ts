// The sidebar's model: workspaces, bookmarks, remotes and tags as sections
// of rows, with bookmarks shown as folders split on "/" or as a flat list.
// Sidebar.svelte draws it.

import { buildTree, treeLines } from "./filetree";
import type { Sidebar as SidebarData, SidebarBookmark } from "./types";

export type Section = "workspaces" | "bookmarks" | "remotes" | "tags";

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

/** `index` numbers entries in the order they're drawn. */
export type SidebarRow =
  | { kind: "folder"; key: string; name: string; padding: number; open: boolean }
  | { kind: "remote"; key: string; index: number; item: SidebarItem; open: boolean }
  | { kind: "item"; index: number; item: SidebarItem; label: string; padding: number; tree: boolean };

export interface SidebarSection {
  id: Section;
  title: string;
  count: number;
  open: boolean;
  rows: SidebarRow[];
}

export interface SidebarView {
  /** Lowercased; empty shows everything. */
  filter: string;
  flat: boolean;
  collapsedSections: Set<string>;
  /** Collapsed folders, keyed by section. */
  collapsedFolders: Set<string>;
}

export function sidebarSections(data: SidebarData, view: SidebarView): SidebarSection[] {
  const { filter, flat, collapsedSections, collapsedFolders } = view;
  let index = 0;
  const matches = (name: string) => !filter || name.toLowerCase().includes(filter);

  const flatRows = (items: SidebarItem[], depth: number): SidebarRow[] =>
    items.map((item) => ({ kind: "item", index: index++, item, label: item.name, padding: 24 + depth * 14, tree: false }));

  /** Rows for bookmarks or tags: folders split on "/" unless flat. */
  const itemRows = (section: string, items: SidebarItem[], depth: number): SidebarRow[] => {
    if (flat || filter) return flatRows(items, depth);
    const collapsed = new Set(
      [...collapsedFolders].filter((k) => k.startsWith(`${section}/`)).map((k) => k.slice(section.length + 1)),
    );
    const base = index;
    const lines = treeLines(buildTree(items.map((i) => i.name)), collapsed);
    index += items.length;
    return lines.map((line): SidebarRow => {
      const padding = 10 + line.depth * 14 + depth * 14;
      if ("folder" in line) return { kind: "folder", key: `${section}/${line.folder}`, name: line.name, padding, open: line.open };
      return { kind: "item", index: base + line.item, item: items[line.item], label: line.name, padding, tree: true };
    });
  };

  const sections: SidebarSection[] = [];
  const section = (id: Section, title: string, count: number, body: () => SidebarRow[]) => {
    if (count === 0 && filter) return;
    const open = filter !== "" || !collapsedSections.has(id);
    sections.push({ id, title, count, open, rows: open ? body() : [] });
  };

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
      remotes.get(r.remote)!.push({ kind: "remote", name: b.name, remote: r.remote, commitId: r.commitId, tracked: r.tracked, bookmark: b });
    }
  }
  const urls = new Map((data.remotes ?? []).map((r) => [r.name, r.url]));

  section("workspaces", "Workspaces", workspaces.length, () => flatRows(workspaces, 0));
  section("bookmarks", "Bookmarks", bookmarks.length, () => itemRows("bookmarks", bookmarks, 0));
  const remoteCount = [...remotes.values()].reduce((n, r) => n + r.length, 0);
  section("remotes", "Remotes", remoteCount, () =>
    [...remotes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([remote, items]): SidebarRow[] => {
        const key = `remotes:${remote}`;
        const open = filter !== "" || !collapsedFolders.has(key);
        const item: SidebarItem = { kind: "remoteRoot", name: remote, remote, commitId: null, url: urls.get(remote) ?? null };
        const root: SidebarRow = { kind: "remote", key, index: index++, item, open };
        return [root, ...(open ? itemRows(key, items, 1) : [])];
      }),
  );
  section("tags", "Tags", tags.length, () => itemRows("tags", tags, 0));
  return sections;
}
