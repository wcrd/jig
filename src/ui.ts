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
export async function runWithToast(label: string, run: () => Promise<CommandOutput>): Promise<boolean> {
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
    `<button class="toast-close" title="Dismiss">×</button></div>` +
    (output.command ? `<div class="toast-command">${escapeHtml(output.command)}</div>` : "") +
    (text ? `<pre class="toast-output">${escapeHtml(text)}</pre>` : "");
  const dismiss = () => toast.remove();
  toast.querySelector(".toast-close")!.addEventListener("click", dismiss);
  if (output.success) setTimeout(dismiss, 5000);
  return output.success;
}

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be refused; nothing useful to do.
  }
}
