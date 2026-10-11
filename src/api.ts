// Calls into the Rust backend, plus small shared helpers.

import { invoke } from "@tauri-apps/api/core";

import type { SplitPlan } from "./details";
import type { ConflictFile } from "./mergeview";
import type { CommandOutput, CommitDiff, CompareDiff, FileDiff, FileText, LogResponse, TreeEntry } from "./types";

export const isTauri = "__TAURI_INTERNALS__" in window;

/** localStorage, which can be unavailable; it only holds conveniences. */
export function storage(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience only.
  }
  return null;
}

// In the browser preview, data comes from files written by the fixture
// example (`cargo run --example fixture`).
async function fixture<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No ${what} in the browser preview fixture`);
  return response.json();
}

export function fetchLog(path: string, revset: string): Promise<LogResponse> {
  if (isTauri) return invoke<LogResponse>("load_log", { path, revset: revset || null });
  return fixture("/fixture.json", "log");
}

export function fetchDiff(path: string, commitId: string): Promise<CommitDiff> {
  if (isTauri) return invoke<CommitDiff>("commit_diff", { path, commitId });
  return fixture(`/diffs/${commitId}.json`, "diff for this commit");
}

export function fetchCompare(path: string, from: string, to: string): Promise<CompareDiff> {
  if (isTauri) return invoke<CompareDiff>("compare_diff", { path, from, to });
  return fixture(`/compare/${from}..${to}.json`, "comparison for these commits");
}

/** One file's diff, for files left out of a commit's or comparison's diff. */
export function fetchFileDiff(
  path: string,
  from: string | null,
  to: string,
  filePath: string,
  sourcePath: string | null,
  force: boolean,
): Promise<FileDiff> {
  return invoke<FileDiff>("file_diff", { path, from, to, filePath, sourcePath, force });
}

export function fetchFileText(path: string, commitId: string, filePath: string): Promise<FileText> {
  if (isTauri) return invoke<FileText>("file_text", { path, commitId, filePath });
  return fixture(`/texts/${commitId}/${filePath.replaceAll("/", "__")}.json`, "text for this file");
}

export function fetchTreeFiles(path: string, commitId: string): Promise<TreeEntry[]> {
  if (isTauri) return invoke<TreeEntry[]>("tree_files", { path, commitId });
  return fixture(`/trees/${commitId}.json`, "tree for this commit");
}

export function fetchHeadOpId(path: string): Promise<string> {
  return invoke<string>("head_op_id", { path });
}

export function fetchInitialRepo(): Promise<{ path: string; explicit: boolean } | null> {
  return invoke("initial_repo");
}

/** Repository changes, run through the user's `jj` so it behaves exactly as jj does. */
export const jj = {
  bookmarkCreate: (path: string, name: string, revision: string) =>
    invoke<CommandOutput>("jj_bookmark_create", { path, name, revision }),
  bookmarkSet: (path: string, name: string, revision: string) =>
    invoke<CommandOutput>("jj_bookmark_set", { path, name, revision }),
  bookmarkDelete: (path: string, name: string) => invoke<CommandOutput>("jj_bookmark_delete", { path, name }),
  bookmarkTrack: (path: string, name: string, remote: string) =>
    invoke<CommandOutput>("jj_bookmark_track", { path, name, remote }),
  gitFetch: (path: string) => invoke<CommandOutput>("jj_git_fetch", { path }),
  gitPush: (path: string, bookmark: string | null = null) => invoke<CommandOutput>("jj_git_push", { path, bookmark }),
  rebase: (path: string, revisions: string[], mode: string, target: string, placement: string) =>
    invoke<CommandOutput>("jj_rebase", { path, revisions, mode, target, placement }),
  newChange: (path: string, parents: string[]) => invoke<CommandOutput>("jj_new", { path, parents }),
  edit: (path: string, revision: string) => invoke<CommandOutput>("jj_edit", { path, revision }),
  abandon: (path: string, revisions: string[]) => invoke<CommandOutput>("jj_abandon", { path, revisions }),
  describe: (path: string, revision: string, message: string) =>
    invoke<CommandOutput>("jj_describe", { path, revision, message }),
  duplicate: (path: string, revisions: string[]) => invoke<CommandOutput>("jj_duplicate", { path, revisions }),
  absorb: (path: string, revision: string) => invoke<CommandOutput>("jj_absorb", { path, revision }),
  squash: (path: string, revision: string, into: string, paths: string[] = []) =>
    invoke<CommandOutput>("jj_squash", { path, revision, into, paths }),
  split: (path: string, revision: string, plan: SplitPlan, message: string | null) =>
    invoke<CommandOutput>("jj_split", { path, revision, plan, message }),
  opRestore: (path: string, opId: string) => invoke<CommandOutput>("jj_op_restore", { path, opId }),
  opRevert: (path: string, opId: string) => invoke<CommandOutput>("jj_op_revert", { path, opId }),
  resolve: (path: string, revision: string, filePath: string, content: string) =>
    invoke<CommandOutput>("jj_resolve", { path, revision, filePath, content }),
  resolveSide: (path: string, revision: string, filePath: string, side: "ours" | "theirs") =>
    invoke<CommandOutput>("jj_resolve_side", { path, revision, filePath, side }),
  undo: (path: string) => invoke<CommandOutput>("jj_undo", { path }),
  redo: (path: string) => invoke<CommandOutput>("jj_redo", { path }),
};

export interface OpEntry {
  id: string;
  shortId: string;
  description: string;
  time: number;
  user: string;
  current: boolean;
  snapshot: boolean;
  /** The command line jj recorded for the operation, e.g. `jj rebase -r abc -o main`. */
  args: string | null;
}

export interface OpChange {
  kind: "added" | "removed" | "rewritten";
  changeId: string;
  commitId: string;
  oldCommitId: string | null;
  summary: string;
  empty: boolean;
}

export interface OpChanges {
  changes: OpChange[];
  bookmarks: { name: string; remote: string | null; from: string | null; to: string | null }[];
  workingCopies: { workspace: string; from: string | null; to: string | null }[];
  truncated: boolean;
}

/** What an operation changed, compared with the operation before it. */
export function fetchOpChanges(path: string, opId: string): Promise<OpChanges> {
  if (!isTauri) return fixture(`/opchanges/${opId}.json`, "changes for this operation");
  return invoke<OpChanges>("op_changes", { path, opId });
}

export function fetchOpLog(path: string, limit = 300): Promise<OpEntry[]> {
  if (!isTauri) return fixture("/oplog.json", "operation log");
  return invoke<OpEntry[]>("op_log", { path, limit });
}

export function fetchConflictHunks(path: string, commitId: string, filePath: string): Promise<ConflictFile> {
  if (!isTauri) return fixture(`/conflicts/${commitId}/${filePath.replaceAll("/", "__")}.json`, "conflict for this file");
  return invoke<ConflictFile>("conflict_hunks", { path, commitId, filePath });
}
