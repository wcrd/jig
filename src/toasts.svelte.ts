// The toasts in the corner: commands while they run and their results, and
// short messages. Toasts.svelte shows them.

export interface Toast {
  id: number;
  kind: "running" | "success" | "failure" | "message";
  label: string;
  /** Shown under the title: the command that ran, and what it printed. */
  command: string;
  output: string;
  /** Wider, for commands whose output is the point. */
  wide: boolean;
  /** Undoes a successful command. */
  undo?: () => void;
  /** A message's button, which waits on a choice. */
  action?: { label: string; run: () => void };
  /** Tells repeats of the same failure apart from new ones. */
  key: string;
  /** How many times the same failure happened. */
  count: number;
  /** Closes by itself after this many ms; null stays until closed. */
  closesAfter: number | null;
}

export const toasts: Toast[] = $state([]);

let nextId = 0;

/** Adds a toast; returns it as stored, so changing it updates the page. */
export function addToast(toast: Partial<Toast> & Pick<Toast, "kind" | "label">): Toast {
  toasts.push({ id: ++nextId, command: "", output: "", wide: false, key: "", count: 1, closesAfter: null, ...toast });
  return toasts[toasts.length - 1];
}

export function removeToast(toast: Toast) {
  const index = toasts.findIndex((t) => t.id === toast.id);
  if (index >= 0) toasts.splice(index, 1);
}

/** Moves a toast to the newest place. */
export function raiseToast(toast: Toast) {
  removeToast(toast);
  toasts.push(toast);
}
