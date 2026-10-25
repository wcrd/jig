// Folder trees for the changed-files list and the repository browser.

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

/** A visible row of a tree: a folder by path, or a file by item. */
export type TreeRow = { folder: string } | { item: number };

/** A visible row with what it takes to draw it: its name, depth and, for folders, whether open. */
export type TreeLine =
  | { folder: string; name: string; depth: number; open: boolean }
  | { item: number; name: string; depth: number; node: TreeNode };

/** The expanded part of a tree, in order, as rows to draw. */
export function treeLines(root: TreeNode, collapsed: Set<string>): TreeLine[] {
  const lines: TreeLine[] = [];
  const walk = (node: TreeNode, depth: number) => {
    for (const child of node.children) {
      if (child.item === undefined) {
        const open = !collapsed.has(child.path);
        lines.push({ folder: child.path, name: child.name, depth, open });
        if (open) walk(child, depth + 1);
      } else {
        lines.push({ item: child.item, name: child.name, depth, node: child });
      }
    }
  };
  walk(root, 0);
  return lines;
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
