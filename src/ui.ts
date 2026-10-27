// Small UI pieces: native context menus, a text prompt, confirmations and
// toasts for command results.

import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { ask } from "@tauri-apps/plugin-dialog";

import { isTauri } from "./api";
import EditText from "./components/EditText.svelte";
import Help from "./components/Help.svelte";
import Prompt from "./components/Prompt.svelte";
import { openDialog } from "./dialog";
import { toastTime } from "./settings";
import { addToast, raiseToast, removeToast, toasts } from "./toasts.svelte";
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
  return openDialog(Prompt, { title, label, initial, placeholder, history });
}

/** Closes every toast but those for commands still running; returns whether there were any. */
export function dismissToasts(): boolean {
  const done = toasts.filter((t) => t.kind !== "running");
  for (const toast of done) removeToast(toast);
  return done.length > 0;
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
  const toast = addToast({ kind: "running", label });

  let output: CommandOutput;
  try {
    output = await run();
  } catch (err) {
    output = { success: false, stdout: "", stderr: String(err), command: "" };
  }
  const text = [output.stderr, output.stdout].map((s) => s.trim()).filter(Boolean).join("\n");
  const key = `${label}\n${output.command}\n${text}`;
  if (!output.success) {
    const same = toasts.find((t) => t.kind === "failure" && t.key === key);
    if (same) {
      removeToast(toast);
      same.count++;
      raiseToast(same);
      return false;
    }
    toast.key = key;
  }
  toast.kind = output.success ? "success" : "failure";
  toast.wide = keepOutput;
  toast.command = output.command;
  toast.output = text;
  if (output.success && undo) toast.undo = undo;
  // Leave time to undo history changes.
  if (output.success && !(keepOutput && text)) toast.closesAfter = undo ? 2 * toastTime() : toastTime();
  return output.success;
}

/**
 * A short message in a toast that closes after the time set in Settings.
 * One offering an `action` stays until closed, since it waits on a choice.
 */
export function notify(message: string, action?: { label: string; run: () => void }) {
  addToast({ kind: "message", label: message, action, closesAfter: action ? null : toastTime() });
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
  return openDialog(EditText, { title, initial, hint });
}

/** A cheat sheet of the keyboard shortcuts. */
export function showHelp() {
  openDialog(Help, {});
}
