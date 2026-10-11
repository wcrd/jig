// Renders a file diff, with the unchanged text between hunks expandable a
// chunk at a time or all at once, plus a plain file view for the browser.

import { escapeHtml } from "./format";
import { highlightLines, type Segment } from "./highlight";
import type { DiffLine, FileDiff } from "./types";
import { displayLength, type LineSet } from "./virtual";

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

/** Two line-number columns. */
const DIFF_GUTTER = 92;
const FILE_GUTTER = 46;

/**
 * The diff's lines, for virtual scrolling, or a placeholder message when
 * there's nothing to show. `lines` is the new file's text once loaded; until
 * then gaps show their controls but no text. `newHighlight` is that text
 * highlighted, which colours context better than highlighting hunks alone.
 */
export function diffLines(
  file: FileDiff,
  expansion: Expansion,
  lines: string[] | null,
  language: string | null,
  newHighlight: Segment[][] | null,
  /** In split mode, what's ticked for the first commit. */
  split: SplitTicks | null = null,
): LineSet | { placeholder: string } {
  if (file.binary) return { placeholder: "Binary file not shown" };
  if (file.omitted) return { placeholder: "Diff too large to show" };
  if (file.hunks.length === 0) {
    return { placeholder: file.status === "added" || file.status === "deleted" ? "Empty file" : "No content changes" };
  }

  const gaps = gapsOf(file);
  const last = gaps.length - 1;
  const hunkSegments = language ? hunkHighlights(file, language) : null;
  const rows: string[] = [];
  let maxChars = 0;
  const context = (from: number, count: number, gap: Gap) => {
    if (!lines || count <= 0) return;
    for (let n = from; n < from + count; n++) maxChars = Math.max(maxChars, displayLength(lines[n - 1] ?? ""));
    rows.push(...contextLines(lines, newHighlight, gap, from, count));
  };

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

    context(gap.from, top, gap);
    const hunk = file.hunks[g];
    // Splitting needs a header with a checkbox on every hunk.
    const check = split && hunk ? hunkCheck(g, split.hunk(g)) : "";
    if (hidden > 0 || (g === 0 && size === 0) || check) {
      rows.push(gapRow(g, hidden, g === 0, g === last, hunk ? hunkHeader(hunk) : "", check));
    }
    context(gap.to - bottom + 1, bottom, gap);

    if (hunk) {
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      hunk.lines.forEach((line, i) => {
        const segments = (line.kind !== "-" && newHighlight?.[newNo - 1]) || hunkSegments?.[g][i] || null;
        const left = line.kind === "+" ? "" : String(oldNo++);
        const right = line.kind === "-" ? "" : String(newNo++);
        maxChars = Math.max(maxChars, displayLength(line.tokens.map(([, t]) => t).join("")));
        if (split && line.kind !== " ") {
          const on = split.line(g, i);
          rows.push(lineHtml(line, left, right, segments, lineCheck(g, i, on), !on));
        } else {
          rows.push(lineHtml(line, left, right, segments));
        }
      });
    }
  });
  return { rows, maxChars: Math.max(maxChars, 60), gutter: DIFF_GUTTER };
}

function hunkHeader(hunk: { oldStart: number; oldCount: number; newStart: number; newCount: number }) {
  return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
}

const UP = `<svg viewBox="0 0 12 12" width="10" height="10"><path d="M6 9.5v-7M2.8 5.5L6 2.3l3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const DOWN = `<svg viewBox="0 0 12 12" width="10" height="10"><path d="M6 2.5v7M2.8 6.5L6 9.7l3.2-3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** In split mode, what's ticked for the first commit. */
export interface SplitTicks {
  hunk(hunk: number): "none" | "some" | "all";
  /** Whether line `line` (an index into the hunk's lines) is ticked. */
  line(hunk: number, line: number): boolean;
}

function hunkCheck(hunk: number, state: "none" | "some" | "all"): string {
  const cls = { none: "", some: " some", all: " on" }[state];
  return `<span class="check${cls}" data-hunk-check="${hunk}" title="Include this hunk in the first commit"></span>`;
}

function lineCheck(hunk: number, line: number, checked: boolean): string {
  return `<span class="check line-check${checked ? " on" : ""}" data-line-check="${hunk}:${line}" title="Include this line in the first commit (shift-click for a range)"></span>`;
}

function gapRow(g: number, hidden: number, first: boolean, last: boolean, header: string, check = ""): string {
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
  return `<div class="line hunk"><span class="no gap-controls">${arrows}</span><span class="code">${check}${label}${escapeHtml(header)}</span></div>`;
}

function contextLines(
  lines: string[],
  highlight: Segment[][] | null,
  gap: Gap,
  from: number,
  count: number,
): string[] {
  const rows: string[] = [];
  for (let n = from; n < from + count; n++) {
    const text = lines[n - 1] ?? "";
    const code = codeHtml([[false, text]], highlight?.[n - 1] ?? null);
    rows.push(`<div class="line ctx"><span class="no">${gap.oldFrom + (n - gap.from)}</span><span class="no">${n}</span><span class="code">${code}</span></div>`);
  }
  return rows;
}

function lineHtml(line: DiffLine, left: string, right: string, segments: Segment[] | null, check = "", unselected = false): string {
  const cls = (line.kind === "+" ? "add" : line.kind === "-" ? "del" : "ctx") + (unselected ? " unselected" : "");
  const tokens = line.kind === " " ? line.tokens.map(([, t]) => [false, t] as [boolean, string]) : line.tokens;
  return `<div class="line ${cls}"><span class="no">${check}${left}</span><span class="no">${right}</span><span class="code">${codeHtml(tokens, segments)}</span></div>`;
}

/**
 * Renders a line's text, combining word-level changes (`tokens`) with syntax
 * highlighting (`segments`). Both split the same text, so this walks them
 * together, starting a new span wherever either changes.
 */
function codeHtml(tokens: [boolean, string][], segments: Segment[] | null): string {
  const text = tokens.map(([, t]) => t).join("");
  if (!segments || segments.map(([, t]) => t).join("") !== text) {
    // No highlighting, or it doesn't line up with this text.
    let html = "";
    for (const [changed, t] of tokens) html += changed ? `<span class="w">${escapeHtml(t)}</span>` : escapeHtml(t);
    return html || " ";
  }
  let html = "";
  let ti = 0;
  let tOffset = 0;
  let si = 0;
  let sOffset = 0;
  while (ti < tokens.length && si < segments.length) {
    const [changed, tText] = tokens[ti];
    const [cls, sText] = segments[si];
    const take = Math.min(tText.length - tOffset, sText.length - sOffset);
    const piece = escapeHtml(sText.slice(sOffset, sOffset + take));
    const classes = [cls, changed ? "w" : ""].filter(Boolean).join(" ");
    html += classes ? `<span class="${classes}">${piece}</span>` : piece;
    tOffset += take;
    sOffset += take;
    if (tOffset === tText.length) {
      ti++;
      tOffset = 0;
    }
    if (sOffset === sText.length) {
      si++;
      sOffset = 0;
    }
  }
  return html || " ";
}

// Highlighting of each side of each hunk, for when the whole file isn't
// loaded (and always for removed lines). Indexed by hunk, then line.
const hunkCache = new WeakMap<FileDiff, (Segment[] | null)[][]>();

function hunkHighlights(file: FileDiff, language: string): (Segment[] | null)[][] | null {
  if (!hunkCache.has(file)) {
    try {
      hunkCache.set(
        file,
        file.hunks.map((hunk) => {
          const text = (line: DiffLine) => line.tokens.map(([, t]) => t).join("");
          const oldSide = highlightLines(hunk.lines.filter((l) => l.kind !== "+").map(text).join("\n"), language);
          const newSide = highlightLines(hunk.lines.filter((l) => l.kind !== "-").map(text).join("\n"), language);
          let o = 0;
          let n = 0;
          return hunk.lines.map((line) => {
            if (line.kind === "-") return oldSide[o++] ?? null;
            if (line.kind === " ") o++;
            return newSide[n++] ?? null;
          });
        }),
      );
    } catch {
      return null;
    }
  }
  return hunkCache.get(file)!;
}

/** A whole file with line numbers, for the file browser. */
export function fileLines(lines: string[], highlight: Segment[][] | null): LineSet {
  let maxChars = 60;
  const rows = lines.map((text, i) => {
    maxChars = Math.max(maxChars, displayLength(text));
    return `<div class="line ctx single"><span class="no">${i + 1}</span><span class="code">${codeHtml([[false, text]], highlight?.[i] ?? null)}</span></div>`;
  });
  return { rows, maxChars, gutter: FILE_GUTTER };
}

/** Splits file text into lines, without a phantom line after a final newline. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}
