// A conflicted file as the merge editor sees it: clean regions already
// merged, and conflict blocks with each side. MergeEditor.svelte edits it.

export type ConflictHunk =
  | { kind: "resolved"; text: string }
  | { kind: "conflict"; base: string[]; sides: string[] };

export interface ConflictFile {
  supported: boolean;
  labels: string[];
  baseLabel: string;
  hunks: ConflictHunk[];
  executable: boolean;
}

export type MergeLayout = "columns" | "stacked";

export interface MergeCallbacks {
  /** Write `content` as the resolution. */
  resolve(content: string): void;
  /** Resolve by taking one whole side with jj's builtin tools. */
  takeSide(side: "ours" | "theirs"): void;
  cancel(): void;
  layoutChanged(layout: MergeLayout): void;
}

/** Text without its final newline, for display in a block. */
export const display = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text);
export const lineCount = (text: string) => (text === "" ? 0 : display(text).split("\n").length);

/** Two blocks one after the other, keeping a line break between them. */
export function joinBlocks(first: string, second: string): string {
  if (first === "" || first.endsWith("\n")) return first + second;
  return `${first}\n${second}`;
}
