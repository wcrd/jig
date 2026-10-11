// The window: a strip of repository tabs, each showing a RepoView.

import { open } from "@tauri-apps/plugin-dialog";

import { fetchInitialRepo, isTauri, storage } from "./api";
import { escapeHtml } from "./format";
import { RepoView } from "./repoview";
import { applyPalette, applyTheme, showSettings } from "./settings";

applyTheme();
applyPalette();

const POLL_MS = 2500;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const template = $<HTMLTemplateElement>("repo-template");
const tabList = $("tab-list");
const viewsEl = $("views");
const emptyEl = $("empty");

const views: RepoView[] = [];
let active: RepoView | null = null;

function saveTabs() {
  storage("tabs", JSON.stringify(views.map((v) => v.path)));
  storage("activeTab", active?.path ?? null);
}

function renderTabs() {
  // Show the parent folder too when two tabs share a name.
  const counts = new Map<string, number>();
  for (const view of views) counts.set(view.name, (counts.get(view.name) ?? 0) + 1);
  tabList.innerHTML = views
    .map((view, i) => {
      const parent = view.path.split("/").filter(Boolean).slice(-2, -1)[0] ?? "";
      const hint = (counts.get(view.name) ?? 0) > 1 && parent ? ` <span class="tab-hint">${escapeHtml(parent)}</span>` : "";
      return `<div class="tab${view === active ? " active" : ""}" data-index="${i}" title="${escapeHtml(view.path)}">
        <span class="tab-name">${escapeHtml(view.name)}${hint}</span>
        <button class="tab-close" data-close="${i}" title="Close tab (⌘W)">
          <svg viewBox="0 0 10 10" width="8" height="8"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button></div>`;
    })
    .join("");
  emptyEl.hidden = views.length > 0;
  document.title = active ? `${active.name} — Jig` : "Jig";
}

function activate(view: RepoView) {
  if (active === view) return;
  active?.root.classList.remove("active");
  active = view;
  view.root.classList.add("active");
  view.activate();
  renderTabs();
  saveTabs();
  view.pollForChanges();
}

function openTab(path: string, { focus = true } = {}): RepoView {
  const existing = views.find((v) => v.path === path);
  if (existing) {
    if (focus) activate(existing);
    return existing;
  }
  const view = new RepoView(template, path);
  view.onChange = renderTabs;
  views.push(view);
  viewsEl.appendChild(view.root);
  view.load();
  if (focus || !active) activate(view);
  else renderTabs();
  saveTabs();
  return view;
}

function closeTab(view: RepoView) {
  const index = views.indexOf(view);
  if (index < 0) return;
  views.splice(index, 1);
  view.root.remove();
  if (active === view) {
    active = null;
    const next = views[Math.min(index, views.length - 1)];
    if (next) activate(next);
  }
  renderTabs();
  saveTabs();
}

async function chooseRepo() {
  if (!isTauri) return;
  const picked = await open({ directory: true, title: "Open jj repository" });
  if (typeof picked === "string") openTab(picked);
}

function cycleTab(delta: number) {
  if (!active || views.length < 2) return;
  const index = views.indexOf(active);
  activate(views[(index + delta + views.length) % views.length]);
}

tabList.addEventListener("mousedown", (event) => {
  const target = event.target as HTMLElement;
  const close = target.closest<HTMLElement>("[data-close]");
  const tab = target.closest<HTMLElement>(".tab");
  if (!tab) return;
  const view = views[Number(tab.dataset.index)];
  // Middle-click closes, as in browsers.
  if (close || event.button === 1) {
    event.preventDefault();
    closeTab(view);
  } else if (event.button === 0) {
    activate(view);
  }
});
$("new-tab").addEventListener("click", chooseRepo);
$("empty-open").addEventListener("click", chooseRepo);

window.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && (event.key === "t" || event.key === "o")) {
    event.preventDefault();
    chooseRepo();
  } else if (mod && event.key === "w") {
    event.preventDefault();
    if (active) closeTab(active);
  } else if (mod && event.key === ",") {
    event.preventDefault();
    showSettings();
  } else if (mod && event.key === "r") {
    event.preventDefault();
    active?.load({ keepPosition: true });
  } else if (mod && event.key === "f") {
    event.preventDefault();
    active?.find();
  } else if (mod && event.key === "l") {
    event.preventDefault();
    active?.focusRevset();
  } else if (mod && /^[1-9]$/.test(event.key)) {
    // ⌘1–⌘8 pick a tab; ⌘9 is always the last.
    event.preventDefault();
    const index = event.key === "9" ? views.length - 1 : Number(event.key) - 1;
    if (views[index]) activate(views[index]);
  } else if ((event.ctrlKey && event.key === "Tab") || (event.metaKey && event.shiftKey && (event.key === "]" || event.key === "["))) {
    event.preventDefault();
    cycleTab(event.key === "[" || event.shiftKey && event.key === "Tab" ? -1 : 1);
  } else if (active?.handleKey(event)) {
    event.preventDefault();
  }
});

// Only the visible tab polls; others catch up when shown.
window.addEventListener("focus", () => active?.pollForChanges());
setInterval(() => {
  if (!document.hidden) active?.pollForChanges();
}, POLL_MS);

// Line widths are chosen per device pixel ratio, so rebuild when it changes.
function watchDpr() {
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener(
    "change",
    () => {
      for (const view of views) view.setDpr(window.devicePixelRatio);
      watchDpr();
    },
    { once: true },
  );
}
watchDpr();

async function start() {
  if (!isTauri) {
    openTab("preview");
    return;
  }
  let saved: string[] = [];
  try {
    saved = JSON.parse(storage("tabs") ?? "[]");
  } catch {
    // Start fresh.
  }
  // Older versions remembered a single repo.
  const last = storage("lastRepo");
  if (saved.length === 0 && last) saved = [last];
  const activePath = storage("activeTab");
  for (const path of saved) openTab(path, { focus: path === activePath });

  const initial = await fetchInitialRepo();
  if (initial && (initial.explicit || views.length === 0)) openTab(initial.path);
  if (!active && views.length > 0) activate(views[0]);
  renderTabs();
}

start();
