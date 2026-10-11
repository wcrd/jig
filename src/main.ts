import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { DetailsPanel } from "./details";
import { Graph, ROW_HEIGHT } from "./graph";
import { renderRow } from "./rows";
import type { CommitDiff, LogResponse } from "./types";

const isTauri = "__TAURI_INTERNALS__" in window;
const OVERSCAN = 8;
const POLL_MS = 2500;
/** Wait this long after the selection settles before loading its diff. */
const DETAILS_DELAY_MS = 40;
const DIFF_CACHE_SIZE = 64;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLElement>("list");
const scroller = $<HTMLDivElement>("scroller");
const spacer = $<HTMLDivElement>("spacer");
const repoName = $<HTMLSpanElement>("repo-name");
const revsetInput = $<HTMLInputElement>("revset-input");
const revsetPreset = $<HTMLSelectElement>("revset-preset");
const statusEl = $<HTMLDivElement>("status");
const errorEl = $<HTMLDivElement>("error");
const emptyEl = $<HTMLDivElement>("empty");

let repoPath: string | null = null;
/** The revset the user asked for; empty means the configured default. */
let revset = "";
let log: LogResponse | null = null;
let selected = -1;
let graph: Graph | null = null;
const rendered = new Map<number, HTMLElement>();
let loading = false;

// Diffs are cached by commit ID: a commit's content never changes.
const diffCache = new Map<string, CommitDiff>();
let detailsTimer = 0;
let detailsRequest = 0;

const details = new DetailsPanel(
  $("commit-info"),
  $("file-header"),
  $("file-list"),
  $("diff-view"),
  {
    selectChange(changeId) {
      const index = log?.rows.findIndex((r) => r.changeId === changeId) ?? -1;
      if (index >= 0) select(index);
    },
  },
);

function storage(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience only.
  }
  return null;
}

async function fetchLog(path: string, revset: string): Promise<LogResponse> {
  if (isTauri) {
    return invoke<LogResponse>("load_log", { path, revset: revset || null });
  }
  // Browser preview: serve a dump from `cargo run --example dump -- --json`.
  const response = await fetch(`/fixture.json`);
  if (!response.ok) throw new Error("No fixture.json for the browser preview");
  return response.json();
}

async function fetchDiff(path: string, commitId: string): Promise<CommitDiff> {
  if (isTauri) return invoke<CommitDiff>("commit_diff", { path, commitId });
  const response = await fetch(`/diffs/${commitId}.json`);
  if (!response.ok) throw new Error("No diff in the browser preview fixture for this commit");
  return response.json();
}

function scheduleDetails() {
  clearTimeout(detailsTimer);
  const row = log && selected >= 0 ? log.rows[selected] : null;
  if (!row || !repoPath) {
    details.clear(log ? "No commit selected" : "");
    return;
  }
  const cached = diffCache.get(row.commitId);
  if (cached) {
    details.show(row, cached);
    return;
  }
  details.showPending(row);
  const path = repoPath;
  const request = ++detailsRequest;
  detailsTimer = window.setTimeout(async () => {
    try {
      const diff = await fetchDiff(path, row.commitId);
      diffCache.set(row.commitId, diff);
      if (diffCache.size > DIFF_CACHE_SIZE) diffCache.delete(diffCache.keys().next().value!);
      if (request === detailsRequest) details.show(row, diff);
    } catch (err) {
      if (request === detailsRequest) details.showError(String(err));
    }
  }, DETAILS_DELAY_MS);
}

async function load({ keepPosition = false } = {}) {
  if (!repoPath || loading) return;
  loading = true;
  const previousChange = log && selected >= 0 ? log.rows[selected]?.changeId : null;
  const previousScroll = scroller.scrollTop;
  statusEl.textContent = "Loading…";
  try {
    const next = await fetchLog(repoPath, revset);
    errorEl.hidden = true;
    log = next;
    graph = new Graph(next.rows, next.edges);
    repoName.textContent = next.workspaceRoot.split("/").pop() || next.workspaceRoot;
    document.title = `${repoName.textContent} — Jork`;
    revsetInput.placeholder = next.defaultRevset;
    if (!revset) revsetInput.value = "";
    selected = previousChange ? next.rows.findIndex((r) => r.changeId === previousChange) : -1;
    if (selected < 0 && !keepPosition) selected = next.rows.findIndex((r) => r.isWorkingCopy);
    spacer.style.height = `${next.rows.length * ROW_HEIGHT}px`;
    for (const el of rendered.values()) el.remove();
    rendered.clear();
    if (keepPosition) scroller.scrollTop = previousScroll;
    else scroller.scrollTop = 0;
    updateStatus();
    render();
    scheduleDetails();
  } catch (err) {
    errorEl.textContent = String(err);
    errorEl.hidden = false;
    statusEl.textContent = "";
  } finally {
    loading = false;
  }
}

function updateStatus() {
  if (!log) return;
  const count = `${log.rows.length.toLocaleString()} ${log.rows.length === 1 ? "commit" : "commits"}`;
  statusEl.textContent = `${count}${log.truncated ? " (truncated)" : ""} · ${log.elapsedMs} ms`;
  statusEl.title = `Operation ${log.opId}: ${log.opDescription}`;
}

let frame = 0;
function render() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(renderNow);
}

function renderNow() {
  emptyEl.hidden = !!repoPath;
  if (!log || !graph) return;
  const top = scroller.scrollTop;
  const height = scroller.clientHeight;
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(log.rows.length - 1, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);

  for (const [index, el] of rendered) {
    if (index < first || index > last) {
      el.remove();
      rendered.delete(index);
    }
  }
  for (let i = first; i <= last; i++) {
    let el = rendered.get(i);
    if (!el) {
      el = document.createElement("div");
      el.className = "row";
      el.dataset.index = String(i);
      renderRow(el, log.rows[i], i, graph);
      spacer.appendChild(el);
      rendered.set(i, el);
    }
    el.classList.toggle("selected", i === selected);
  }

}

function rerenderRows() {
  for (const el of rendered.values()) el.remove();
  rendered.clear();
  render();
}

function select(index: number, reveal = true) {
  if (!log || log.rows.length === 0) return;
  const previous = selected;
  selected = Math.max(0, Math.min(log.rows.length - 1, index));
  if (selected !== previous) scheduleDetails();
  if (reveal) {
    const y = selected * ROW_HEIGHT;
    if (y < scroller.scrollTop) scroller.scrollTop = y;
    else if (y + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = y + ROW_HEIGHT - scroller.clientHeight;
    }
  }
  render();
}

async function openRepo(path: string) {
  repoPath = path;
  storage("lastRepo", path);
  revset = storage(`revset:${path}`) ?? "";
  revsetInput.value = revset;
  syncPreset();
  log = null;
  diffCache.clear();
  details.clear();
  await load();
}

async function chooseRepo() {
  if (!isTauri) return;
  const picked = await open({ directory: true, title: "Open jj repository" });
  if (typeof picked === "string") await openRepo(picked);
}

function syncPreset() {
  const match = [...revsetPreset.options].find((o) => o.value === revset && o.value !== "custom");
  revsetPreset.value = match ? match.value : "custom";
}

function applyRevset(value: string) {
  revset = value.trim();
  if (repoPath) storage(`revset:${repoPath}`, revset || null);
  revsetInput.value = revset;
  syncPreset();
  load();
}

// Picks up changes made with jj elsewhere (e.g. in a terminal).
async function pollForChanges() {
  if (!isTauri || !repoPath || !log || loading || document.hidden) return;
  try {
    const opId = await invoke<string>("head_op_id", { path: repoPath });
    if (log && opId !== log.opId) await load({ keepPosition: true });
  } catch {
    // Errors surface on the next explicit load.
  }
}

scroller.addEventListener("scroll", render, { passive: true });
new ResizeObserver(render).observe(list);
// Line widths are chosen per device pixel ratio, so rebuild when it changes.
function watchDpr() {
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener(
    "change",
    () => {
      graph?.setDpr(window.devicePixelRatio);
      rerenderRows();
      watchDpr();
    },
    { once: true },
  );
}
watchDpr();

spacer.addEventListener("mousedown", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".row");
  if (row) select(Number(row.dataset.index), false);
});

$("open-repo").addEventListener("click", chooseRepo);
$("empty-open").addEventListener("click", chooseRepo);
$("refresh").addEventListener("click", () => load({ keepPosition: true }));
revsetPreset.addEventListener("change", () => {
  if (revsetPreset.value !== "custom") applyRevset(revsetPreset.value);
});
revsetInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    applyRevset(revsetInput.value);
    revsetInput.blur();
  } else if (event.key === "Escape") {
    revsetInput.value = revset;
    revsetInput.blur();
  }
});

window.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key === "r") {
    event.preventDefault();
    load({ keepPosition: true });
    return;
  }
  if (mod && event.key === "o") {
    event.preventDefault();
    chooseRepo();
    return;
  }
  if (mod && event.key === "l") {
    event.preventDefault();
    revsetInput.focus();
    revsetInput.select();
    return;
  }
  if (document.activeElement === revsetInput || !log) return;
  const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_HEIGHT) - 1);
  const moves: Record<string, number> = {
    ArrowDown: selected + 1,
    ArrowUp: selected - 1,
    PageDown: selected + page,
    PageUp: selected - page,
    Home: 0,
    End: log.rows.length - 1,
  };
  // ⌥↑/⌥↓ step through the selected commit's files.
  if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    details.moveFile(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key in moves) {
    event.preventDefault();
    select(moves[event.key]);
  }
});

/** Makes a splitter resize `target` along one axis, remembering the size. */
function splitter(
  handle: HTMLElement,
  target: HTMLElement,
  axis: "rows" | "columns",
  key: string,
  min: number,
  maxFraction: number,
) {
  const saved = Number(storage(key));
  const apply = (size: number) => {
    const container = target.parentElement!;
    const total = axis === "rows" ? container.clientHeight : container.clientWidth;
    const clamped = Math.max(min, Math.min(size, total * maxFraction));
    target.style[axis === "rows" ? "height" : "width"] = `${clamped}px`;
    return clamped;
  };
  if (saved) apply(saved);

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add(`resizing-${axis}`);
    const start = axis === "rows" ? event.clientY : event.clientX;
    const rect = target.getBoundingClientRect();
    const startSize = axis === "rows" ? rect.height : rect.width;
    // The details panel sits below its splitter, so dragging up grows it.
    const sign = axis === "rows" ? -1 : 1;
    let size = startSize;
    const move = (e: PointerEvent) => {
      const delta = (axis === "rows" ? e.clientY : e.clientX) - start;
      size = apply(startSize + sign * delta);
      render();
    };
    const up = () => {
      document.body.classList.remove(`resizing-${axis}`);
      handle.removeEventListener("pointermove", move);
      storage(key, String(Math.round(size)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
  });
}

splitter($("split-details"), $("details"), "rows", "detailsHeight", 120, 0.85);
splitter($("split-info"), $("info-pane"), "columns", "infoWidth", 220, 0.6);

window.addEventListener("focus", pollForChanges);
setInterval(pollForChanges, POLL_MS);

async function start() {
  if (!isTauri) {
    repoPath = "preview";
    await load();
    return;
  }
  const initial = await invoke<{ path: string; explicit: boolean } | null>("initial_repo");
  const last = storage("lastRepo");
  const path = initial?.explicit ? initial.path : (last ?? initial?.path ?? null);
  if (path) await openRepo(path);
  else render();
}

start();
