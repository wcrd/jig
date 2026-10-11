// A small find bar (⌘F) that floats over the area being searched.

export interface SearchTarget {
  /** Applies a query; returns how many matches there are. */
  setQuery(query: string): number;
  /** Moves to the next or previous match; returns its 1-based position. */
  step(delta: 1 | -1): number;
  clear(): void;
}

export class SearchBar {
  private el: HTMLElement;
  private input: HTMLInputElement;
  private count: HTMLElement;
  private target: SearchTarget | null = null;
  private total = 0;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "search-bar";
    this.el.hidden = true;
    this.el.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <input spellcheck="false" autocomplete="off" placeholder="Find" />
      <span class="search-count"></span>
      <button data-step="-1" title="Previous (⇧↩)">↑</button>
      <button data-step="1" title="Next (↩)">↓</button>
      <button data-close title="Close (Esc)">×</button>`;
    this.input = this.el.querySelector("input")!;
    this.count = this.el.querySelector(".search-count")!;
    this.input.addEventListener("input", () => this.apply());
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.step(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
    this.el.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("button");
      if (!button) return;
      if (button.dataset.close !== undefined) this.close();
      else this.step(Number(button.dataset.step) as 1 | -1);
    });
  }

  /** Opens the bar over `host`, searching `target`. */
  open(host: HTMLElement, target: SearchTarget) {
    if (this.target && this.target !== target) this.target.clear();
    this.target = target;
    host.appendChild(this.el);
    this.el.hidden = false;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.apply();
  }

  close() {
    this.target?.clear();
    this.target = null;
    this.el.hidden = true;
    this.el.remove();
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  private apply() {
    const query = this.input.value;
    this.total = query ? (this.target?.setQuery(query) ?? 0) : 0;
    if (!query) this.target?.clear();
    this.count.textContent = query ? (this.total ? `${this.total} found` : "No matches") : "";
    this.el.classList.toggle("none", !!query && this.total === 0);
    if (this.total) this.step(1);
  }

  private step(delta: 1 | -1) {
    if (!this.target || !this.total) return;
    const at = this.target.step(delta);
    this.count.textContent = `${at} of ${this.total}`;
  }
}
