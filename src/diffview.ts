// Renders a file diff, with the unchanged text between hunks expandable a
// chunk at a time or all at once, plus a plain file view for the browser.

import { escapeHtml } from "./format";
import type { DiffLine, FileDiff } from "./types";

/** Lines revealed per click on an expand control. */
export const EXPAND_STEP = 20;

/**
 * How much of each gap is revealed. Gap `g` is the unchanged text before hunk
 * `g`; the last gap follows the final hunk. `top` lines show below the hunk
 * above the gap and `bottom` lines above the hunk below it.
 */
export interface Expansion {
  full: boolean;
  gaps: Map<number, { top: number; bottom: number }>;
}

export function newExpansion(): Expansion {
  return { full: false, gaps: new Map() };
}

interface Gap {
  /** First and last new-file line in the gap (1-based, inclusive). */
  from: number;
  to: number;
  /** Old-file line number of `from`. */
  oldFrom: number;
}

function gapsOf(file: FileDiff): Gap[] {
  const gaps: Gap[] = [];
  let newNext = 1;
  let oldNext = 1;
  for (const hunk of file.hunks) {
    gaps.push({ from: newNext, to: hunk.newStart - 1, oldFrom: oldNext });
    newNext = hunk.newStart + hunk.newCount;
    oldNext = hunk.oldStart + hunk.oldCount;
  }
  gaps.push({ from: newNext, to: file.newLineCount, oldFrom: oldNext });
  return gaps;
}

/** Whether any unchanged text is hidden, i.e. expanding would show more. */
export function hasHiddenText(file: FileDiff, expansion: Expansion): boolean {
  if (expansion.full) return false;
  return gapsOf(file).some((gap, g) => {
    const size = gap.to - gap.from + 1;
    const shown = expansion.gaps.get(g);
    return size > (shown ? shown.top + shown.bottom : 0);
  });
}

export function expandGap(expansion: Expansion, gap: number, direction: "up" | "down" | "all") {
  const shown = expansion.gaps.get(gap) ?? { top: 0, bottom: 0 };
  if (direction === "all") {
    shown.top = Number.MAX_SAFE_INTEGER;
  } else if (direction === "down") {
    shown.top += EXPAND_STEP;
  } else {
    shown.bottom += EXPAND_STEP;
  }
  expansion.gaps.set(gap, shown);
}

/**
 * The diff body. `lines` is the new file's text once loaded; until then gaps
 * show their controls but no text.
 */
export function diffBodyHtml(file: FileDiff, expansion: Expansion, lines: string[] | null): string {
  if (file.binary) return `<div class="placeholder-text">Binary file not shown</div>`;
  if (file.omitted) return `<div class="placeholder-text">Diff too large to show</div>`;
  if (file.hunks.length === 0) {
    return `<div class="placeholder-text">${file.status === "added" || file.status === "deleted" ? "Empty file" : "No content changes"}</div>`;
  }

  const gaps = gapsOf(file);
  const last = gaps.length - 1;
  let html = `<div class="diff-lines">`;

  gaps.forEach((gap, g) => {
    const size = Math.max(0, gap.to - gap.from + 1);
    const shown = expansion.gaps.get(g) ?? { top: 0, bottom: 0 };
    let top = 0;
    let bottom = 0;
    if (!lines) {
      // Nothing to show until the file's text has loaded.
    } else if (expansion.full) {
      top = size;
    } else if (g === 0) {
      // Nothing sits above the first gap, so it only opens upwards.
      bottom = Math.min(size, shown.top + shown.bottom);
    } else if (g === last) {
      // And the last gap only opens downwards.
      top = Math.min(size, shown.top + shown.bottom);
    } else {
      top = Math.min(size, shown.top);
      bottom = Math.min(size - top, shown.bottom);
    }
    const hidden = size - top - bottom;

    html += contextLines(lines, gap, gap.from, top);
    const hunk = file.hunks[g];
    if (hidden > 0 || (g === 0 && size === 0)) {
      html += gapRow(g, hidden, g === 0, g === last, hunk ? hunkHeader(hunk) : "");
    }
    html += contextLines(lines, gap, gap.to - bottom + 1, bottom);

    if (hunk) {
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      for (const line of hunk.lines) {
        const left = line.kind === "+" ? "" : String(oldNo++);
        const right = line.kind === "-" ? "" : String(newNo++);
        html += lineHtml(line, left, right);
      }
    }
  });
  return html + `</div>`;
}

function hunkHeader(hunk: { oldStart: number; oldCount: number; newStart: number; newCount: number }) {
  return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
}

const UP = `<svg viewBox="0 0 12 12" width="10" height="10"><path d="M6 9.5v-7M2.8 5.5L6 2.3l3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DOWN = `<svg viewBox="0 0 12 12" width="10" height="10"><path d="M6 2.5v7M2.8 6.5L6 9.7l3.2-3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function gapRow(g: number, hidden: number, first: boolean, last: boolean, header: string): string {
  // Arrows sit in the gutter; the "show all" label goes before the header.
  let arrows = "";
  let label = "";
  if (hidden > 0) {
    const text = `${hidden} unchanged ${hidden === 1 ? "line" : "lines"}`;
    if (hidden > EXPAND_STEP) {
      if (!first) arrows += `<button class="expand" data-gap="${g}" data-dir="down" title="Show ${EXPAND_STEP} more lines below">${DOWN}</button>`;
      if (!last) arrows += `<button class="expand" data-gap="${g}" data-dir="up" title="Show ${EXPAND_STEP} more lines above">${UP}</button>`;
    }
    label = `<button class="expand label" data-gap="${g}" data-dir="all" title="Show all ${text}">${hidden <= EXPAND_STEP ? (first ? UP : DOWN) : ""}Show ${text}</button>`;
  }
  return `<div class="line hunk"><span class="no gap-controls">${arrows}</span><span class="code">${label}${escapeHtml(header)}</span></div>`;
}

function contextLines(lines: string[] | null, gap: Gap, from: number, count: number): string {
  if (!lines || count <= 0) return "";
  let html = "";
  for (let n = from; n < from + count; n++) {
    const text = lines[n - 1] ?? "";
    html += `<div class="line ctx"><span class="no">${gap.oldFrom + (n - gap.from)}</span><span class="no">${n}</span><span class="code">${escapeHtml(text) || " "}</span></div>`;
  }
  return html;
}

function lineHtml(line: DiffLine, left: string, right: string): string {
  const cls = line.kind === "+" ? "add" : line.kind === "-" ? "del" : "ctx";
  let code = "";
  for (const [changed, text] of line.tokens) {
    const escaped = escapeHtml(text);
    code += changed && line.kind !== " " ? `<span class="w">${escaped}</span>` : escaped;
  }
  return `<div class="line ${cls}"><span class="no">${left}</span><span class="no">${right}</span><span class="code">${code || " "}</span></div>`;
}

/** A whole file with line numbers, for the file browser. */
export function fileBodyHtml(lines: string[]): string {
  let html = `<div class="diff-lines single">`;
  lines.forEach((text, i) => {
    html += `<div class="line ctx"><span class="no">${i + 1}</span><span class="code">${escapeHtml(text) || " "}</span></div>`;
  });
  return html + `</div>`;
}

/** Splits file text into lines, without a phantom line after a final newline. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}
