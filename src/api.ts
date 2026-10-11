// Calls into the Rust backend, plus small shared helpers.

import { invoke } from "@tauri-apps/api/core";

import type { CommitDiff, CompareDiff, FileText, LogResponse, TreeEntry } from "./types";

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
