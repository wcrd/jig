// The window's tabs: one per open repository, each a Repo. Tabs drag to
// reorder, onto another window, or out into a window of their own. App.svelte
// draws them.

import { open } from "@tauri-apps/plugin-dialog";
import { flushSync } from "svelte";

import { fetchInitialRepo, isTauri, openFolder, storage } from "./api";
import { Repo } from "./repo.svelte";
import { showSettings } from "./settings";
import { type MenuEntry, copy, dismissToasts, notify, showHelp, showMenu } from "./ui";
import { checkForUpdates } from "./updates";
import {
  type Bounds,
  type TabDrop,
  type TabHandover,
  type TabRequest,
  type WindowOffset,
  type WindowPoint,
  type WindowSession,
  MAIN_WINDOW,
  clientPoint,
  closeWindow,
  focusWindow,
  forgetSession,
  onWindowEvent,
  openWindow,
  openWindowLabels,
  saveSession,
  savedSessions,
  sendTo,
  takeWindowInit,
  watchWindow,
  windowAt,
  windowBounds,
  windowLabel,
} from "./windows";

const POLL_MS = 2500;
/** How far a press on a tab moves before it's a drag. */
const DRAG_THRESHOLD = 5;
/** How far above and below the tab strip a dragged tab still reorders: up over the title bar, and a little way down. */
const STRIP_SLOP_ABOVE = 40;
const STRIP_SLOP_BELOW = 24;

// The tab strip's elements, from App.svelte.
let tabStrip: HTMLElement;
let tabList: HTMLElement;
let dropMarker: HTMLElement;

/** The tabs, in order. */
const views: Repo[] = $state([]);
/** The same repos in the order they opened, which is how their views sit in the page: moving one would lose its scroll positions. */
const opened: Repo[] = $state([]);
let active = $state<Repo | null>(null);
let bounds: Bounds | undefined;

/** Where a dragged tab would go if let go now; null puts it back. */
type DropTarget =
  | { kind: "strip" }
  | ({ kind: "window" } & WindowPoint)
  | { kind: "new" }
  | null;

interface TabDrag {
  view: Repo;
  pointerId: number;
  startX: number;
  startY: number;
  /** Its place before the drag, for Esc. */
  startIndex: number;
  moved: boolean;
  target: DropTarget;
  /** Lookups of the window under the pointer, numbered so late answers don't undo newer ones. */
  lookups: number;
  applied: number;
}

let drag = $state<TabDrag | null>(null);

/** What App.svelte draws. */
export const tabs = {
  get views() {
    return views;
  },
  get opened() {
    return opened;
  },
  get active() {
    return active;
  },
  /** The tab being dragged, once it has moved. */
  get dragged() {
    return drag?.moved ? drag.view : null;
  },
  /** Whether the dragged tab would leave this window if let go now. */
  get leaving() {
    return !!drag?.moved && leavesWindow(drag.target);
  },
};

export function attachTabStrip(strip: HTMLElement, list: HTMLElement, marker: HTMLElement) {
  tabStrip = strip;
  tabList = list;
  dropMarker = marker;
}

function saveTabs() {
  saveSession({ tabs: views.map((v) => v.path), active: active?.path ?? null, bounds });
}

const leavesWindow = (target: DropTarget) => target?.kind === "window" || target?.kind === "new";

/**
 * For tabs that share a name, the fewest parent folders that tell them
 * apart: `work/repo` and `personal/repo` show `work` and `personal`, and
 * `a/x/repo` and `b/x/repo` show `a/x` and `b/x`.
 */
export function nameHints(): Map<Repo, string> {
  const groups = new Map<string, Repo[]>();
  for (const view of views) groups.set(view.name, [...(groups.get(view.name) ?? []), view]);
  const hints = new Map<Repo, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const parents = group.map((view) => view.path.split("/").filter(Boolean).slice(0, -1));
    const deepest = Math.max(...parents.map((p) => p.length));
    for (let depth = 1; depth <= deepest; depth++) {
      const labels = parents.map((p) => p.slice(-depth).join("/"));
      if (new Set(labels).size === labels.length || depth === deepest) {
        group.forEach((view, i) => labels[i] && hints.set(view, labels[i]));
        break;
      }
    }
  }
  return hints;
}

/** Draws the tabs now, for code that measures them straight after. */
function renderTabs() {
  flushSync();
}

function activate(view: Repo) {
  if (active === view) return;
  active = view;
  renderTabs();
  view.activate();
  saveTabs();
  view.pollForChanges();
}

function openTab(
  path: string,
  { focus = true, index = views.length, changeId = null }: { focus?: boolean; index?: number; changeId?: string | null } = {},
): Repo {
  const existing = views.find((v) => v.path === path);
  if (existing) {
    if (focus) activate(existing);
    return existing;
  }
  const view = new Repo(path);
  view.onOpen = openRepo;
  if (changeId) view.selectOnLoad(changeId);
  views.splice(index, 0, view);
  opened.push(view);
  // Its view has to be in the page before it loads.
  renderTabs();
  view.load();
  if (focus || !active) activate(view);
  else renderTabs();
  saveTabs();
  return view;
}

function closeTab(view: Repo) {
  const index = views.indexOf(view);
  if (index < 0) return;
  views.splice(index, 1);
  opened.splice(opened.indexOf(view), 1);
  if (active === view) {
    active = null;
    const next = views[Math.min(index, views.length - 1)];
    if (next) activate(next);
  }
  renderTabs();
  saveTabs();
  closeIfEmpty();
}

/** A window with no tabs left closes, unless it's the last one. */
async function closeIfEmpty() {
  if (views.length > 0 || !isTauri) return;
  const others = (await openWindowLabels()).filter((label) => label !== windowLabel);
  if (others.length > 0 && views.length === 0) closeWindow();
}

/** Opens `path` in a tab here, or switches to its tab; a tab for it in another window moves here. */
async function openRepo(path: string) {
  if (!views.some((v) => v.path === path)) {
    const open = new Set(await openWindowLabels());
    for (const [label, session] of savedSessions()) {
      if (label !== windowLabel && open.has(label) && session.tabs.includes(path)) {
        // It comes back with `take-tab`.
        sendTo(label, "give-tab", { path, to: windowLabel } satisfies TabRequest);
        return;
      }
    }
  }
  openTab(path);
}

function moveTab(view: Repo, index: number) {
  const from = views.indexOf(view);
  views.splice(from, 1);
  views.splice(Math.min(index, views.length), 0, view);
}

export async function chooseRepo() {
  if (!isTauri) return;
  const picked = await open({ directory: true, title: "Open jj repository" });
  if (typeof picked === "string") openRepo(picked);
}

function cycleTab(delta: number) {
  if (!active || views.length < 2) return;
  const index = views.indexOf(active);
  activate(views[(index + delta + views.length) % views.length]);
}

// Dragging tabs

const tabElements = () => [...tabList.querySelectorAll<HTMLElement>(".tab")];

/** Where a tab let go at `x` in the strip goes: before the first tab whose middle is right of it. */
function indexAt(x: number, tabs: HTMLElement[]): number {
  return tabs.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2 < x;
  }).length;
}

/** Where a tab dropped on this window goes; anywhere below the strip adds it at the end. */
function dropIndex(x: number, y: number): number {
  return y > tabStrip.getBoundingClientRect().bottom ? views.length : indexAt(x, tabElements());
}

function overStrip(x: number, y: number): boolean {
  const strip = tabStrip.getBoundingClientRect();
  return x >= 0 && x < window.innerWidth && y >= strip.top - STRIP_SLOP_ABOVE && y <= strip.bottom + STRIP_SLOP_BELOW;
}

function insideWindow(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
}

/** The target for a point outside this window: the window under it, or a new one. */
function targetFor(hit: WindowPoint | null): DropTarget {
  if (!hit) return { kind: "new" };
  // This window's own frame, around the web view.
  if (hit.label === windowLabel) return null;
  return { kind: "window", ...hit };
}

/** The target for a pointer position; outside this window it means asking which window is there. */
async function targetAt(event: PointerEvent): Promise<DropTarget> {
  if (overStrip(event.clientX, event.clientY)) return { kind: "strip" };
  // The browser preview has no other windows to drop on.
  if (insideWindow(event.clientX, event.clientY) || !isTauri) return null;
  return targetFor(await windowAt().catch(() => null));
}

function setTarget(d: TabDrag, target: DropTarget) {
  const was = d.target;
  if (was?.kind === "window" && (target?.kind !== "window" || target.label !== was.label)) {
    sendTo(was.label, "tab-drag-over", null);
  }
  if (target?.kind === "window") sendTo(target.label, "tab-drag-over", { x: target.x, fromBottom: target.fromBottom } satisfies WindowOffset);
  d.target = target;
  if (leavesWindow(was) !== leavesWindow(target)) renderTabs();
}

async function trackDrag(d: TabDrag, event: PointerEvent) {
  const n = ++d.lookups;
  const target = await targetAt(event);
  if (drag !== d || n < d.applied) return;
  d.applied = n;
  setTarget(d, target);
  // Reorder live within the strip.
  if (target?.kind === "strip") {
    const others = tabElements().filter((el) => views[Number(el.dataset.index)] !== d.view);
    const index = indexAt(event.clientX, others);
    if (index !== views.indexOf(d.view)) {
      moveTab(d.view, index);
      renderTabs();
    }
  }
}

function endDragState(d: TabDrag) {
  drag = null;
  document.body.classList.remove("tab-dragging");
  if (d.target?.kind === "window") sendTo(d.target.label, "tab-drag-over", null);
  if (tabList.hasPointerCapture(d.pointerId)) tabList.releasePointerCapture(d.pointerId);
  renderTabs();
}

export function cancelDrag() {
  if (!drag) return;
  const d = drag;
  if (d.moved) moveTab(d.view, d.startIndex);
  endDragState(d);
}

/** Moves a tab into a window of its own, with its selected commit. */
async function moveToNewWindow(view: Repo, { atCursor = false } = {}) {
  const path = view.path;
  const changeId = view.selectedChangeId();
  const session: WindowSession = { tabs: [path], active: path, selected: changeId ? { [path]: changeId } : undefined };
  await openWindow(session, { atCursor });
  closeTab(view);
}

async function dropTab(d: TabDrag, event: PointerEvent) {
  // The last lookup may be behind where the tab was let go.
  const target = await targetAt(event);
  endDragState(d);
  const path = d.view.path;
  const changeId = d.view.selectedChangeId();
  try {
    if (target?.kind === "window") {
      await sendTo(target.label, "tab-drop", { path, changeId, x: target.x, fromBottom: target.fromBottom } satisfies TabDrop);
      closeTab(d.view);
      return;
    }
    // A window's only tab dragged out is already in a window of its own.
    if (target?.kind === "new" && views.length > 1) {
      await moveToNewWindow(d.view, { atCursor: true });
      return;
    }
  } catch (err) {
    notify(`Couldn't move the tab: ${err}`);
  }
  saveTabs();
}

export function tabPointerDown(event: PointerEvent) {
  const target = event.target as HTMLElement;
  const tab = target.closest<HTMLElement>(".tab");
  if (!tab || drag) return;
  const view = views[Number(tab.dataset.index)];
  // Middle-click closes, as in browsers.
  if (target.closest("[data-close]") || event.button === 1) {
    event.preventDefault();
    closeTab(view);
    return;
  }
  if (event.button !== 0 || event.ctrlKey) return;
  activate(view);
  drag = {
    view,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startIndex: views.indexOf(view),
    moved: false,
    target: { kind: "strip" },
    lookups: 0,
    applied: 0,
  };
  // Keeps the pointer's events coming once it leaves the window.
  tabList.setPointerCapture(event.pointerId);
}

export function tabPointerMove(event: PointerEvent) {
  const d = drag;
  if (!d || event.pointerId !== d.pointerId) return;
  if (!d.moved) {
    if (Math.hypot(event.clientX - d.startX, event.clientY - d.startY) < DRAG_THRESHOLD) return;
    d.moved = true;
    document.body.classList.add("tab-dragging");
    renderTabs();
  }
  trackDrag(d, event);
}

export function tabPointerUp(event: PointerEvent) {
  const d = drag;
  if (!d || event.pointerId !== d.pointerId) return;
  // Done with the pointer, though the drop may still be finding its window.
  drag = null;
  if (d.moved) dropTab(d, event);
  else endDragState(d);
}

export function tabMenu(event: MouseEvent) {
  const tab = (event.target as HTMLElement).closest<HTMLElement>(".tab");
  if (!tab) return;
  event.preventDefault();
  const view = views[Number(tab.dataset.index)];
  const entries: MenuEntry[] = [
    { text: "Open in Finder", action: () => openFolder(view.path).catch((err) => notify(String(err))) },
    { text: "Open in Terminal", action: () => openFolder(view.path, "Terminal").catch((err) => notify(String(err))) },
    { text: "Copy Path", action: () => copy(view.path) },
    "separator",
    {
      text: "Move to New Window",
      enabled: views.length > 1,
      action: () => moveToNewWindow(view).catch((err) => notify(`Couldn't move the tab: ${err}`)),
    },
    "separator",
    { text: "Close Tab", shortcut: "CmdOrCtrl+W", action: () => closeTab(view) },
    { text: "Close Other Tabs", enabled: views.length > 1, action: () => views.filter((v) => v !== view).forEach(closeTab) },
  ];
  showMenu(entries);
}

/** Shows where a tab dragged from another window would land. */
function showDropMarker(over: WindowOffset | null) {
  tabStrip.classList.toggle("drop-target", !!over);
  dropMarker.hidden = !over;
  if (!over) return;
  const at = clientPoint(over);
  const tabs = tabElements();
  const index = dropIndex(at.x, at.y);
  const left =
    index < tabs.length
      ? tabs[index].getBoundingClientRect().left
      : tabs.length > 0
        ? tabs[tabs.length - 1].getBoundingClientRect().right
        : tabList.getBoundingClientRect().left;
  dropMarker.style.left = `${left - tabStrip.getBoundingClientRect().left - 1}px`;
}

function acceptTab(drop: TabDrop) {
  showDropMarker(null);
  const at = clientPoint(drop);
  const index = dropIndex(at.x, at.y);
  const existing = views.find((v) => v.path === drop.path);
  if (existing) {
    moveTab(existing, views.indexOf(existing) < index ? index - 1 : index);
    renderTabs();
    activate(existing);
    saveTabs();
  } else {
    openTab(drop.path, { index, changeId: drop.changeId });
  }
  focusWindow();
}

/** Hands this window's tab for a repo to the window opening it, which opens it anyway if there's none. */
async function giveTab({ path, to }: TabRequest) {
  const view = views.find((v) => v.path === path);
  await sendTo(to, "take-tab", { path, changeId: view?.selectedChangeId() ?? null } satisfies TabHandover);
  if (view) closeTab(view);
}

function takeTab({ path, changeId }: TabHandover) {
  openTab(path, { changeId });
  focusWindow();
}

/** Commands from the menu bar, by menu item id; their shortcuts are handled below. */
const MENU_COMMANDS: Record<string, () => void> = {
  "new-window": () => openWindow({ tabs: [], active: null }),
  "new-tab": chooseRepo,
  "close-tab": () => active && closeTab(active),
  "close-window": closeWindow,
  settings: showSettings,
  "check-for-updates": checkForUpdates,
  find: () => active?.find(),
  reload: () => active?.load({ keepPosition: true }),
  "next-tab": () => cycleTab(1),
  "previous-tab": () => cycleTab(-1),
  help: showHelp,
};

function keydown(event: KeyboardEvent) {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (drag && event.key === "Escape") {
    event.preventDefault();
    cancelDrag();
  } else if (mod && key === "n" && isTauri) {
    event.preventDefault();
    openWindow({ tabs: [], active: null });
  } else if (mod && event.shiftKey && key === "w" && isTauri) {
    event.preventDefault();
    closeWindow();
  } else if (mod && (event.key === "t" || event.key === "o")) {
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
  } else if (event.key === "Escape" && !event.defaultPrevented && !usesEscape(event) && dismissToasts()) {
    // Esc that nothing else wanted clears the toasts.
    event.preventDefault();
  }
}

/** Whether Esc already means something where it was pressed: leaving a text field or closing a dialog. */
function usesEscape(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  return !!target?.closest("input, textarea, select, [contenteditable]") || !!document.querySelector("dialog[open]");
}


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

function restore(session: WindowSession | undefined) {
  if (!session) return;
  bounds = session.bounds;
  for (const path of session.tabs) {
    openTab(path, { focus: path === session.active, changeId: session.selected?.[path] ?? null });
  }
}

/** Tabs saved by versions with a single window. */
function legacySession(): WindowSession | undefined {
  let tabs: string[] = [];
  try {
    tabs = JSON.parse(storage("tabs") ?? "[]");
  } catch {
    // Start fresh.
  }
  // Older versions still remembered a single repo.
  const last = storage("lastRepo");
  if (tabs.length === 0 && last) tabs = [last];
  const active = storage("activeTab");
  for (const key of ["tabs", "activeTab", "lastRepo"]) storage(key, null);
  return tabs.length > 0 ? { tabs, active } : undefined;
}

/** The main window brings back its own tabs and every other window's. */
function restoreAllWindows() {
  const sessions = savedSessions();
  let own = sessions.get(MAIN_WINDOW) ?? legacySession();
  sessions.delete(MAIN_WINDOW);
  // The main window was closed before quitting, so it takes over another's tabs.
  const [first] = sessions.keys();
  if (!own && first) {
    own = sessions.get(first);
    sessions.delete(first);
    forgetSession(first);
  }
  restore(own);
  for (const [label, session] of sessions) openWindow(session, { label }).catch(() => forgetSession(label));
}

let boundsTimer = 0;
function trackBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = window.setTimeout(async () => {
    bounds = await windowBounds().catch(() => bounds);
    saveTabs();
  }, 300);
}

/** Starts the window: its keys and polling, and its tabs from last time. */
export async function start() {
  window.addEventListener("keydown", keydown);
  // Only the visible tab polls; others catch up when shown.
  window.addEventListener("focus", () => active?.pollForChanges());
  setInterval(() => {
    if (!document.hidden) active?.pollForChanges();
  }, POLL_MS);
  watchDpr();
  if (!isTauri) {
    restore(savedSessions().get(windowLabel));
    if (views.length === 0) openTab("preview");
    return;
  }
  await Promise.all([
    // Folders macOS hands to the running app (`open -a Jig.app <dir>`, a Dock drop) go to the frontmost window.
    onWindowEvent<string>("open-repo", openRepo),
    onWindowEvent<TabRequest>("give-tab", giveTab),
    onWindowEvent<TabHandover>("take-tab", takeTab),
    onWindowEvent<WindowOffset | null>("tab-drag-over", showDropMarker),
    onWindowEvent<TabDrop>("tab-drop", acceptTab),
    onWindowEvent<string>("menu", (id) => MENU_COMMANDS[id]?.()),
  ]);
  watchWindow({
    changed: trackBounds,
    // Closing a window forgets its tabs; closing the last one, or quitting, keeps them for next time.
    closing: async () => {
      if ((await openWindowLabels()).length > 1) forgetSession();
    },
  });

  if (windowLabel === MAIN_WINDOW) {
    restoreAllWindows();
    const initial = await fetchInitialRepo();
    if (initial && (initial.explicit || views.length === 0)) openTab(initial.path);
  } else {
    restore((await takeWindowInit()) ?? savedSessions().get(windowLabel));
  }
  if (!active && views.length > 0) activate(views[0]);
  trackBounds();
}
