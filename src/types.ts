// Mirrors the serialized types in src-tauri/src/repo.rs and layout.rs.

export type EdgeKind = "direct" | "indirect" | "missing";

export interface EdgeLayout {
  fromRow: number;
  fromLane: number;
  lane: number;
  toRow: number | null;
  toLane: number;
  kind: EdgeKind;
}

export type RefLabel =
  | { type: "bookmark"; name: string; conflict: boolean; tracked: boolean; synced: boolean }
  | { type: "remoteBookmark"; name: string; remote: string; tracked: boolean }
  | { type: "tag"; name: string };

export interface LogRow {
  commitId: string;
  commitPrefixLen: number;
  changeId: string;
  changePrefixLen: number;
  summary: string;
  hasBody: boolean;
  authorName: string;
  authorEmail: string;
  coauthors: { name: string; email: string }[];
  timestamp: number;
  parentCount: number;
  isWorkingCopy: boolean;
  workspaces: string[];
  immutable: boolean;
  conflict: boolean;
  empty: boolean;
  divergent: boolean;
  inWcHistory: boolean;
  refs: RefLabel[];
  lane: number;
  width: number;
}

export interface LogResponse {
  workspaceRoot: string;
  workspaceName: string;
  opId: string;
  opDescription: string;
  revset: string;
  defaultRevset: string;
  rows: LogRow[];
  edges: EdgeLayout[];
  maxWidth: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface Person {
  name: string;
  email: string;
  timestamp: number;
}

export interface ParentInfo {
  commitId: string;
  changeId: string;
  summary: string;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface DiffLine {
  kind: " " | "+" | "-";
  /** Text segments; `true` marks a changed word. */
  tokens: [boolean, string][];
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  sourcePath: string | null;
  status: FileStatus;
  conflict: boolean;
  binary: boolean;
  omitted: boolean;
  additions: number;
  deletions: number;
  oldLineCount: number;
  newLineCount: number;
  hunks: Hunk[];
}

export interface CommitDiff {
  commitId: string;
  changeId: string;
  description: string;
  author: Person;
  committer: Person;
  parents: ParentInfo[];
  files: FileDiff[];
}

export interface FileText {
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
  conflict: boolean;
}

export interface TreeEntry {
  path: string;
  kind: "file" | "executable" | "symlink" | "submodule" | "conflict";
}

export interface CompareDiff {
  from: string;
  to: string;
  files: FileDiff[];
}
