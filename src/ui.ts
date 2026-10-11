// Small UI pieces: native context menus, a text prompt, confirmations and
// toasts for command results.

import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { ask } from "@tauri-apps/plugin-dialog";

import { isTauri } from "./api";
import { escapeHtml } from "./format";
import type { CommandOutput } from "./types";

export type MenuEntry =
  | { text: string; action: () => void; enabled?: boolean }
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
      return MenuItem.new({ text: entry.text, enabled: entry.enabled ?? true, action: entry.action });
    }),
  );
}

/** Shows a native context menu at the pointer. */
export async function showMenu(entries: MenuEntry[]) {
  if (!isTauri) return;
  const menu = await Menu.new({ items: await buildItems(entries) });
  await menu.popup();
}

export async function confirm(message: string, title: string, okLabel: string): Promise<boolean> {
  if (!isTauri) return window.confirm(message);
  return ask(message, { title, kind: "warning", okLabel, cancelLabel: "Cancel" });
}

/** Asks for a line of text in a small modal; resolves to null if cancelled. */
export function prompt(title: string, label: string, initial = "", placeholder = ""): Promise<string | null> {
  const dialog = document.createElement("dialog");
  dialog.className = "prompt";
  dialog.innerHTML = `<form method="dialog">
    <div class="prompt-title">${escapeHtml(title)}</div>
    <label>${escapeHtml(label)}<input name="value" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(placeholder)}" /></label>
    <div class="prompt-buttons"><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">OK</button></div>
  </form>`;
  document.body.appendChild(dialog);
  const input = dialog.querySelector("input")!;
  input.value = initial;
  // Enter would otherwise submit with the form's first button, Cancel.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dialog.close("ok");
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

/**
 * Runs a jj command, showing a toast while it runs and with its result
 * afterwards. Failures stay until dismissed; successes fade out.
 */
export async function runWithToast(
  label: string,
  run: () => Promise<CommandOutput>,
  undo?: () => void,
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
  toast.className = `toast ${output.success ? "success" : "failure"}`;
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
  if (output.success) setTimeout(dismiss, undo ? 10000 : 5000);
  return output.success;
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
    <textarea name="value" spellcheck="true" rows="10"></textarea>
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
      ["d", "Show changes"],
      ["r", "Rebase"],
      ["⇧S", "Squash"],
      ["s", "Split"],
      ["a", "Abandon"],
      ["y", "Copy (cherry-pick)"],
      ["⇧R", "Revert"],
      ["⇧A", "Absorb"],
      ["⇧B", "Set bookmark"],
      ["b", "Find bookmark"],
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
      ["⌘F", "Find in graph, or in the diff"],
      ["⇧L  ⌘L", "Revset"],
      ["⌘R", "Reload"],
      ["⌥↑ ⌥↓", "Previous / next file"],
      ["⌘T  ⌘W", "Open / close tab"],
      ["⌘1–9", "Switch tab"],
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
