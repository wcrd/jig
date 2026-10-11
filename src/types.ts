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
