// Small UI pieces: native context menus, a text prompt, confirmations and
// toasts for command results.

import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { ask } from "@tauri-apps/plugin-dialog";

import { isTauri } from "./api";
import { escapeHtml } from "./format";
import { toastTime } from "./settings";
import type { CommandOutput } from "./types";

export type MenuEntry =
  // `shortcut` is a Tauri accelerator such as "N" or "Shift+S", shown beside the item.
  | { text: string; action: () => void; enabled?: boolean; shortcut?: string }
  | { text: string; items: MenuEntry[] }
  | "separator";

type NativeItem = MenuItem | PredefinedMenuItem | Submenu;

async function buildItems(entries: MenuEntry[]): Promise<NativeItem[]> {
  return Promise.all(
    entries.map(async (entry): Promise<NativeItem> => {
      if (entry === "separator") return PredefinedMenuItem.new({ item: "Separator" });
      if ("items" in entry) {
        return Submenu.new({ text: entry.text, items: await buildItems(entry.items) });
      }
      return MenuItem.new({
        text: entry.text,
        enabled: entry.enabled ?? true,
        accelerator: entry.shortcut,
        action: entry.action,
      });
    }),
  );
}

/** Shows a native context menu at the pointer, or at `at` in window coordinates. */
export async function showMenu(entries: MenuEntry[], at?: { x: number; y: number }) {
  if (!isTauri) return;
  const menu = await Menu.new({ items: await buildItems(entries) });
  await menu.popup(at ? new LogicalPosition(at.x, at.y) : undefined);
}

export async function confirm(message: string, title: string, okLabel: string): Promise<boolean> {
  if (!isTauri) return window.confirm(message);
  return ask(message, { title, kind: "warning", okLabel, cancelLabel: "Cancel" });
}

/**
 * Asks for a line of text in a small modal; resolves to null if cancelled.
 * With `history` (oldest first), ↑ / ↓ step through earlier entries.
 */
export function prompt(
  title: string,
  label: string,
  initial = "",
  placeholder = "",
  history: string[] = [],
): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "prompt";
  dialog.innerHTML = `<form method="dialog">
    <div class="prompt-title">${escapeHtml(title)}</div>
    <label>${escapeHtml(label)}<input name="value" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" placeholder="${escapeHtml(placeholder)}" /></label>
    <div class="prompt-buttons"><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">OK</button></div>
  </form>`;
  document.body.appendChild(dialog);
  const input = dialog.querySelector("input")!;
  input.value = initial;
  // Where ↑ / ↓ are in `history`; its length is the line being typed.
  let place = history.length;
  let typed = initial;
  // Enter would otherwise submit with the form's first button, Cancel.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dialog.close("ok");
    } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && history.length > 0) {
      event.preventDefault();
      if (place === history.length) typed = input.value;
      place = Math.max(0, Math.min(history.length, place + (event.key === "ArrowUp" ? -1 : 1)));
      input.value = place === history.length ? typed : history[place];
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const value = dialog.returnValue === "ok" ? input.value.trim() : "";
      dialog.remove();
      resolve(value || null);
    });
    dialog.showModal();
    input.select();
  });
}

const toasts = (() => {
  const el = document.createElement("div");
  el.className = "toasts";
  document.body.appendChild(el);
  return el;
})();

// A ring that drains while a toast waits to close; its circumference is
// --ring in the stylesheet.
const TIMER = `<span class="toast-timer" title="Closes by itself; hover to keep it open"><svg viewBox="0 0 16 16" width="12" height="12"><circle class="toast-timer-track" cx="8" cy="8" r="6"/><circle class="toast-timer-left" cx="8" cy="8" r="6"/></svg></span>`;

/**
 * Closes `toast` after `ms`, draining its ring meanwhile. The toast closes
 * when the ring's animation ends, so hovering, which pauses the animation,
 * holds it open.
 */
function closeAfter(toast: HTMLElement, ms: number) {
  toast.querySelector(".toast-close")!.insertAdjacentHTML("beforebegin", TIMER);
  const ring = toast.querySelector<SVGElement>(".toast-timer-left")!;
  ring.style.animationDuration = `${ms}ms`;
  ring.addEventListener("animationend", () => toast.remove());
}

/** Closes every toast but those for commands still running; returns whether there were any. */
export function dismissToasts(): boolean {
  const done = [...toasts.querySelectorAll(".toast:not(.running)")];
  for (const toast of done) toast.remove();
  return done.length > 0;
}

/** Counts a failure again on the toast already showing it, and moves that toast to the newest place. */
function repeatFailure(toast: HTMLElement) {
  const count = Number(toast.dataset.count ?? 1) + 1;
  toast.dataset.count = String(count);
  let badge = toast.querySelector(".toast-count");
  if (!badge) {
    toast.querySelector(".toast-close")!.insertAdjacentHTML("beforebegin", `<span class="toast-count"></span>`);
    badge = toast.querySelector(".toast-count")!;
  }
  badge.textContent = `×${count}`;
  toasts.appendChild(toast);
}

/**
 * Runs a jj command, showing a toast while it runs and with its result
 * afterwards. Failures stay until closed, and a repeat of one showing adds
 * to its count; successes close after the time set in Settings (twice that
 * with Undo), unless `keepOutput` and there's output to read.
 */
export async function runWithToast(
  label: string,
  run: () => Promise<CommandOutput>,
  undo?: () => void,
  keepOutput = false,
): Promise<boolean> {
  const toast = document.createElement("div");
  toast.className = "toast running";
  toast.innerHTML = `<div class="toast-title"><span class="spinner"></span>${escapeHtml(label)}…</div>`;
  toasts.appendChild(toast);

  let output: CommandOutput;
  try {
    output = await run();
  } catch (err) {
    output = { success: false, stdout: "", stderr: String(err), command: "" };
  }
  const text = [output.stderr, output.stdout].map((s) => s.trim()).filter(Boolean).join("\n");
  const key = `${label}\n${output.command}\n${text}`;
  if (!output.success) {
    const same = [...toasts.querySelectorAll<HTMLElement>(".toast.failure")].find((t) => t.dataset.key === key);
    if (same) {
      toast.remove();
      repeatFailure(same);
      return false;
    }
    toast.dataset.key = key;
  }
  toast.className = `toast ${output.success ? "success" : "failure"}${keepOutput ? " wide" : ""}`;
  toast.innerHTML =
    `<div class="toast-title">${output.success ? "✓" : "✕"} ${escapeHtml(label)}` +
    (output.success && undo ? `<button class="toast-undo">Undo</button>` : "") +
    `<button class="toast-close" title="Dismiss">×</button></div>` +
    (output.command ? `<div class="toast-command">${escapeHtml(output.command)}</div>` : "") +
    (text ? `<pre class="toast-output">${escapeHtml(text)}</pre>` : "");
  const dismiss = () => toast.remove();
  toast.querySelector(".toast-close")!.addEventListener("click", dismiss);
  toast.querySelector(".toast-undo")?.addEventListener("click", () => {
    dismiss();
    undo?.();
  });
  // Leave time to undo history changes.
  if (output.success && !(keepOutput && text)) closeAfter(toast, undo ? 2 * toastTime() : toastTime());
  return output.success;
}

/**
 * A short message in a toast that closes after the time set in Settings.
 * One offering an `action` stays until closed, since it waits on a choice.
 */
export function notify(message: string, action?: { label: string; run: () => void }) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML =
    `<div class="toast-title">${escapeHtml(message)}` +
    (action ? `<button class="toast-undo toast-action">${escapeHtml(action.label)}</button>` : "") +
    `<button class="toast-close" title="Dismiss">×</button></div>`;
  toasts.appendChild(toast);
  toast.querySelector(".toast-close")!.addEventListener("click", () => toast.remove());
  if (action) {
    toast.querySelector(".toast-action")!.addEventListener("click", () => {
      toast.remove();
      action.run();
    });
  } else {
    closeAfter(toast, toastTime());
  }
}

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be refused; nothing useful to do.
  }
}

/** Edits multi-line text (a commit message); resolves to null if cancelled. */
export function editText(title: string, initial: string, hint = ""): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "prompt editor";
  dialog.innerHTML = `<form method="dialog">
    <div class="prompt-title">${escapeHtml(title)}</div>
    <textarea name="value" spellcheck="true" autocapitalize="off" autocorrect="off" rows="10"></textarea>
    <div class="prompt-buttons"><span class="muted prompt-hint">${escapeHtml(hint)}</span><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">Save</button></div>
  </form>`;
  document.body.appendChild(dialog);
  const textarea = dialog.querySelector("textarea")!;
  textarea.value = initial;
  // Save with ⌘↩, or jjui's ⌥↩ / ⌃S; ⌃X clears, as in jjui.
  textarea.addEventListener("keydown", (event) => {
    const save =
      (event.key === "Enter" && (event.metaKey || event.ctrlKey || event.altKey)) ||
      (event.ctrlKey && event.key.toLowerCase() === "s");
    if (save) {
      event.preventDefault();
      dialog.close("ok");
    } else if (event.ctrlKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      textarea.value = "";
    }
  });
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const ok = dialog.returnValue === "ok";
      const value = textarea.value;
      dialog.remove();
      resolve(ok ? value : null);
    });
    dialog.showModal();
    textarea.focus();
    textarea.setSelectionRange(0, 0);
  });
}

const HELP: [string, [string, string][]][] = [
  [
    "Commits",
    [
      ["↑ ↓  j k", "Move"],
      ["⇧J  ⇧K", "Parent / child"],
      ["@", "Working copy"],
      ["n", "New change"],
      ["e", "Edit"],
      ["↩  ⇧D", "Describe"],
      ["c", "Commit the working copy"],
      ["d", "Full-size diff (↑ ↓ move between files)"],
      ["← →", "Shrink / grow details"],
      ["Space", "Mark for rebase, squash, copy, revert, abandon"],
      ["Esc", "Clear marks"],
      ["r", "Rebase"],
      ["⇧S", "Squash"],
      ["s", "Split"],
      ["a", "Abandon"],
      ["y", "Copy (cherry-pick)"],
      ["⇧R", "Revert"],
      ["⇧A", "Absorb"],
      ["⇧B", "Set bookmark"],
      ["b", "Bookmarks menu"],
      ["⇧M", "Set parents"],
      ["⌘-click", "Compare"],
    ],
  ],
  [
    "Rebase",
    [
      ["r / s / ⇧B", "This commit / with descendants / branch"],
      ["o / a / b", "Onto / after / before"],
      ["↑ ↓  @", "Choose destination"],
      ["↩  Esc", "Rebase / cancel"],
    ],
  ],
  [
    "Copy / revert",
    [
      ["o / a / b", "Onto / after / before"],
      ["↑ ↓  @", "Choose destination"],
      ["↩  Esc", "Run / cancel"],
    ],
  ],
  [
    "Set parents",
    [
      ["↑ ↓  @", "Move"],
      ["Space", "Mark / unmark a parent"],
      ["↩  Esc", "Set / cancel"],
    ],
  ],
  [
    "Abandon",
    [
      ["Space", "Mark"],
      ["s", "Mark descendants"],
      ["↩  Esc", "Abandon / cancel"],
    ],
  ],
  [
    "Repository",
    [
      ["u  ⇧U", "Undo / redo"],
      ["o", "Operation log"],
      ["g", "Fetch / push"],
      [":", "Run a jj command (aliases too)"],
      ["⌘F", "Find in graph, or in the diff"],
      ["⇧L  ⌘L", "Revset"],
      ["⌘R", "Reload"],
      ["⌥↑ ⌥↓", "Previous / next file"],
      ["⌘T  ⌘W", "Open / close tab"],
      ["⌘N  ⇧⌘W", "New / close window"],
      ["⌘1–9", "Switch tab"],
      ["Esc", "Close toasts"],
      ["?", "This help"],
      ["⌘,", "Settings"],
    ],
  ],
];

/** A cheat sheet of the keyboard shortcuts. */
export function showHelp() {
  const dialog = document.createElement("dialog");
  dialog.className = "prompt help";
  dialog.innerHTML =
    `<div class="prompt-title">Keyboard Shortcuts <span class="muted">(the same as jjui)</span></div><div class="help-grid">` +
    HELP.map(
      ([title, keys]) =>
        `<div class="help-section"><div class="list-section">${title}</div>` +
        keys.map(([key, what]) => `<div class="help-row"><kbd>${escapeHtml(key)}</kbd><span>${escapeHtml(what)}</span></div>`).join("") +
        `</div>`,
    ).join("") +
    `</div><div class="prompt-buttons"><button class="primary" autofocus>Done</button></div>`;
  document.body.appendChild(dialog);
  dialog.querySelector("button")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.showModal();
}
