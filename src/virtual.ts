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

export class VirtualLines {
  private lines: LineSet | null = null;
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
  }
}

/** Display width of a line in characters, with tabs as 4. */
export function displayLength(text: string): number {
  let n = 0;
  for (const c of text) n += c === "\t" ? 4 : 1;
  return n;
}
