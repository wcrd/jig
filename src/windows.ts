// Jig's windows: each remembers its own tabs, and tabs move between them.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { isTauri, storage } from "./api";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a window shows, saved so it comes back at the next launch. */
export interface WindowSession {
  tabs: string[];
  active: string | null;
  bounds?: Bounds;
  /** The change to select per tab, for tabs handed over from another window. */
  selected?: Record<string, string>;
}

/** A point in a window: from its left, as `clientX` gives it, and up from its bottom. */
export interface WindowOffset {
  x: number;
  fromBottom: number;
}

/** The point in this window's own coordinates. */
export function clientPoint(offset: WindowOffset): { x: number; y: number } {
  return { x: offset.x, y: window.innerHeight - offset.fromBottom };
}

/** A tab dropped on this window from another one, where it was let go. */
export interface TabDrop extends WindowOffset {
  path: string;
  changeId: string | null;
}

export interface WindowPoint extends WindowOffset {
  label: string;
}

/** The first window at launch, which brings the others back. */
export const MAIN_WINDOW = "main";
export const windowLabel = isTauri ? getCurrentWebviewWindow().label : MAIN_WINDOW;

const SESSION_PREFIX = "window:";

/** Each window writes only its own key, so windows never overwrite each other. */
export function saveSession(session: WindowSession) {
  storage(SESSION_PREFIX + windowLabel, JSON.stringify(session));
}

export function forgetSession(label = windowLabel) {
  storage(SESSION_PREFIX + label, null);
}

/** Every window's saved session, by window label. */
export function savedSessions(): Map<string, WindowSession> {
  const sessions = new Map<string, WindowSession>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(SESSION_PREFIX)) continue;
      const session = JSON.parse(localStorage.getItem(key) ?? "null");
      if (Array.isArray(session?.tabs)) sessions.set(key.slice(SESSION_PREFIX.length), session);
    }
  } catch {
    // Storage is a convenience only.
  }
  return sessions;
}

/**
 * Opens a window showing `session`: at its saved bounds, with the pointer
 * over its first tab, or else cascaded from this window.
 */
export function openWindow(session: WindowSession, { label = newLabel(), atCursor = false } = {}) {
  return invoke("open_window", { label, init: session, atCursor, bounds: session.bounds ?? null });
}

function newLabel(): string {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The session another window opened this one with, if it did. */
export function takeWindowInit(): Promise<WindowSession | null> {
  return invoke("take_window_init");
}

/** The frontmost window under the pointer. */
export function windowAt(): Promise<WindowPoint | null> {
  return invoke("window_at");
}

export async function openWindowLabels(): Promise<string[]> {
  if (!isTauri) return [windowLabel];
  return (await getAllWebviewWindows()).map((w) => w.label);
}

/** Sends an event to one window. */
export function sendTo(label: string, event: string, payload: unknown) {
  return emitTo(label, event, payload);
}

/** Listens for events sent to this window. */
export function onWindowEvent<T>(event: string, handler: (payload: T) => void) {
  return listen<T>(event, (e) => handler(e.payload), { target: windowLabel });
}

export function focusWindow() {
  return getCurrentWebviewWindow().setFocus();
}

/** Closes this window as its close button would. */
export function closeWindow() {
  return getCurrentWebviewWindow().close();
}

/** This window's frame in logical pixels, as `open_window` takes it. */
export async function windowBounds(): Promise<Bounds> {
  const window = getCurrentWebviewWindow();
  const scale = await window.scaleFactor();
  const position = (await window.outerPosition()).toLogical(scale);
  const size = (await window.innerSize()).toLogical(scale);
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

/** Calls `handler` when this window moves, resizes or is about to close. */
export function watchWindow(handlers: { changed: () => void; closing: () => Promise<void> }) {
  const window = getCurrentWebviewWindow();
  window.onMoved(handlers.changed);
  window.onResized(handlers.changed);
  window.onCloseRequested(handlers.closing);
}
