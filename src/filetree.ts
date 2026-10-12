// Folder trees for the changed-files list and the repository browser.

import { escapeHtml } from "./format";

export interface TreeNode {
  name: string;
  /** Full path of the folder or file. */
  path: string;
  children: TreeNode[];
  /** Index of the item, for files. */
  item?: number;
}

/**
 * Builds a tree from paths, folders first then files, alphabetically. Chains
 * of folders with a single subfolder are collapsed into one node ("src/lib").
 */
export function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [] };
  const folders = new Map<string, TreeNode>([["", root]]);
  paths.forEach((path, item) => {
    const parts = path.split("/");
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const folderPath = parts.slice(0, i + 1).join("/");
      let folder = folders.get(folderPath);
      if (!folder) {
        folder = { name: parts[i], path: folderPath, children: [] };
        folders.set(folderPath, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({ name: parts[parts.length - 1], path, children: [], item });
  });
  sortAndCompress(root);
  return root;
}

function sortAndCompress(node: TreeNode) {
  for (const child of node.children) {
    if (child.item !== undefined) continue;
    while (child.children.length === 1 && child.children[0].item === undefined) {
      const only = child.children[0];
      child.name = `${child.name}/${only.name}`;
      child.path = only.path;
      child.children = only.children;
    }
    sortAndCompress(child);
  }
  node.children.sort((a, b) => {
    const aFolder = a.item === undefined;
    const bFolder = b.item === undefined;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

const CHEVRON = `<svg class="chevron" viewBox="0 0 10 10" width="9" height="9"><path d="M3 2l3.5 3L3 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FOLDER = `<svg class="icon folder" viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="currentColor"/></svg>`;

export interface TreeRenderOptions {
  /** Folder paths that are collapsed. */
  collapsed: Set<string>;
  /** HTML for a file row's contents (after the indent). */
  fileHtml(item: number, node: TreeNode): string;
  selected: number;
  /** A folder with keyboard focus, highlighted instead of the selected file. */
  selectedFolder?: string | null;
}

/** A visible row of a tree: a folder by path, or a file by item. */
export type TreeRow = { folder: string } | { item: number };

/** Renders the expanded part of a tree; returns its visible rows in order. */
export function renderTree(root: TreeNode, options: TreeRenderOptions): { html: string; rows: TreeRow[] } {
  let html = "";
  const rows: TreeRow[] = [];
  const focused = options.selectedFolder ?? null;
  const walk = (node: TreeNode, depth: number) => {
    for (const child of node.children) {
      const indent = `style="padding-left:${10 + depth * 14}px"`;
      if (child.item === undefined) {
        const open = !options.collapsed.has(child.path);
        rows.push({ folder: child.path });
        const selected = child.path === focused ? " selected" : "";
        html += `<div class="tree-row folder${open ? " open" : ""}${selected}" data-folder="${escapeHtml(child.path)}" ${indent}>${CHEVRON}${FOLDER}<span class="name">${escapeHtml(child.name)}</span></div>`;
        if (open) walk(child, depth + 1);
      } else {
        rows.push({ item: child.item });
        const selected = focused === null && child.item === options.selected ? " selected" : "";
        html += `<div class="tree-row file${selected}" data-index="${child.item}" ${indent}><span class="chevron-space"></span>${options.fileHtml(child.item, child)}</div>`;
      }
    }
  };
  walk(root, 0);
  return { html, rows };
}

/** Every folder path in a tree, for collapsing a whole tree. */
export function folderPaths(root: TreeNode): string[] {
  const paths: string[] = [];
  const walk = (node: TreeNode) => {
    for (const child of node.children) {
      if (child.item === undefined) {
        paths.push(child.path);
        walk(child);
      }
    }
  };
  walk(root);
  return paths;
}
