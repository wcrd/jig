// Virtual scrolling for diffs and file views: only the lines near the
// viewport are in the DOM, so huge files scroll smoothly.

export const LINE_HEIGHT = 18;
const OVERSCAN = 40;

let charWidth = 0;
/** Width of one monospace character in the diff font. */
function monoCharWidth(): number {
  if (!charWidth) {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `12px ui-monospace, "SF Mono", Menlo, monospace`;
    charWidth = ctx.measureText("0".repeat(100)).width / 100;
  }
  return charWidth;
}

export interface LineSet {
  /** HTML for each line, each a `.line` element. */
  rows: string[];
  /** Longest line, in characters (tabs counted as 4), for the scroll width. */
  maxChars: number;
  /** Width of the line-number gutters in pixels. */
  gutter: number;
}

/** The text of a rendered line's code cell (escapeHtml uses numeric entities). */
function rowText(html: string): string {
  const code = /<span class="code">([\s\S]*)<\/span><\/div>$/.exec(html)?.[1] ?? "";
  return code.replace(/<[^>]+>/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export class VirtualLines {
  private lines: LineSet | null = null;
  // Find (⌘F): the query, the matching line indices and the current match.
  private query = "";
  private matches: number[] = [];
  private current = -1;
  private texts: string[] | null = null;
  private body: HTMLElement | null = null;
  private window: HTMLElement | null = null;
  private first = -1;
  private last = -1;
  private frame = 0;

  constructor(private scroller: HTMLElement) {
    scroller.addEventListener("scroll", () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(scroller);
  }

  /** Shows `lines` inside `body`, which must be within the scroller. */
  mount(body: HTMLElement, lines: LineSet) {
    this.lines = lines;
    this.body = body;
    const width = lines.gutter + Math.ceil(lines.maxChars * monoCharWidth()) + 32;
    body.innerHTML = `<div class="vlines" style="height:${lines.rows.length * LINE_HEIGHT + 8}px;width:${width}px"><div class="vwindow"></div></div>`;
    this.window = body.querySelector(".vwindow");
    this.first = -1;
    this.last = -1;
    this.texts = null;
    // Keep an open search going across files.
    if (this.query) this.findMatches();
    this.renderNow();
  }

  /** Find: highlights lines containing `query`; returns the number of matches. */
  setQuery(query: string): number {
    this.query = query.toLowerCase();
    this.findMatches();
    this.current = -1;
    this.refresh();
    return this.matches.length;
  }

  /** Moves to the next or previous match; returns its 1-based position. */
  step(delta: 1 | -1): number {
    if (this.matches.length === 0 || !this.body) return 0;
    this.current = (this.current + delta + this.matches.length) % this.matches.length;
    const line = this.matches[this.current];
    this.scroller.scrollTop = Math.max(0, this.body.offsetTop + line * LINE_HEIGHT - this.scroller.clientHeight / 3);
    this.refresh();
    return this.current + 1;
  }

  clear() {
    this.query = "";
    this.matches = [];
    this.current = -1;
    this.refresh();
  }

  private findMatches() {
    if (!this.lines) {
      this.matches = [];
      return;
    }
    this.texts ??= this.lines.rows.map(rowText);
    this.matches = [];
    this.texts.forEach((text, i) => {
      if (text.toLowerCase().includes(this.query)) this.matches.push(i);
    });
  }

  private refresh() {
    this.first = -1;
    this.last = -1;
    this.renderNow();
  }

  unmount() {
    this.lines = null;
    this.body = null;
    this.window = null;
  }

  private schedule() {
    if (!this.lines) return;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderNow());
  }

  private renderNow() {
    const lines = this.lines;
    const body = this.body;
    const window = this.window;
    if (!lines || !body || !window || !body.isConnected) return;
    // The body sits below a sticky header, so offset by where it starts.
    const offset = body.offsetTop;
    const top = Math.max(0, this.scroller.scrollTop - offset);
    const height = this.scroller.clientHeight;
    const first = Math.max(0, Math.floor(top / LINE_HEIGHT) - OVERSCAN);
    const last = Math.min(lines.rows.length - 1, Math.ceil((top + height) / LINE_HEIGHT) + OVERSCAN);
    if (first === this.first && last === this.last) return;
    this.first = first;
    this.last = last;
    window.style.top = `${first * LINE_HEIGHT}px`;
    window.innerHTML = lines.rows.slice(first, last + 1).join("");
    if (this.query) this.highlight(window, first);
  }

  /** Marks matches in the rendered window: the line, and the text itself. */
  private highlight(window: HTMLElement, first: number) {
    const hits = new Set(this.matches);
    const current = this.matches[this.current];
    const rows = window.children;
    for (let i = 0; i < rows.length; i++) {
      const index = first + i;
      if (!hits.has(index)) continue;
      const row = rows[i] as HTMLElement;
      row.classList.add("search-hit");
      if (index === current) row.classList.add("current");
      const code = row.querySelector(".code");
      if (code) markText(code, this.query);
    }
  }
}

/** Display width of a line in characters, with tabs as 4. */
export function displayLength(text: string): number {
  let n = 0;
  for (const c of text) n += c === "\t" ? 4 : 1;
  return n;
}

/** Wraps case-insensitive occurrences of `query` in text nodes with <mark>. */
export function markText(root: Element, query: string) {
  if (!query) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    const lower = text.toLowerCase();
    let at = lower.indexOf(query);
    if (at < 0) continue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    while (at >= 0) {
      fragment.append(text.slice(last, at));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(at, at + query.length);
      fragment.append(mark);
      last = at + query.length;
      at = lower.indexOf(query, last);
    }
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
}
