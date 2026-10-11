// One open repository: its toolbar, graph and details panel, with all of
// its state. Each tab owns a RepoView, so switching tabs keeps scroll
// position, selection and everything else.

import { fetchDiff, fetchFileText, fetchHeadOpId, fetchLog, fetchTreeFiles, isTauri, storage } from "./api";
import { DetailsPanel } from "./details";
import { Graph, ROW_HEIGHT } from "./graph";
import { renderRow } from "./rows";
import type { CommitDiff, LogResponse } from "./types";

const OVERSCAN = 8;
/** Wait this long after the selection settles before loading its diff. */
const DETAILS_DELAY_MS = 40;
const DIFF_CACHE_SIZE = 64;

export class RepoView {
  readonly root: HTMLElement;
  /** Shown in the tab; the folder name until the log loads. */
  name: string;
  onChange: () => void = () => {};

  /** The revset the user asked for; empty means the configured default. */
  private revset: string;
  private log: LogResponse | null = null;
  private graph: Graph | null = null;
  private selected = -1;
  private rendered = new Map<number, HTMLElement>();
  private loading = false;
  private frame = 0;

  // Diffs are cached by commit ID: a commit's content never changes.
  private diffCache = new Map<string, CommitDiff>();
  private detailsTimer = 0;
  private detailsRequest = 0;
  private details: DetailsPanel;

  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private revsetInput: HTMLInputElement;
  private revsetPreset: HTMLSelectElement;
  private statusEl: HTMLElement;
  private errorEl: HTMLElement;

  constructor(
    template: HTMLTemplateElement,
    readonly path: string,
  ) {
    this.root = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    this.name = path.split("/").filter(Boolean).pop() ?? path;
    this.revset = storage(`revset:${path}`) ?? "";

    this.scroller = this.ref("scroller");
    this.spacer = this.ref("spacer");
    this.revsetInput = this.ref("revset-input");
    this.revsetPreset = this.ref("revset-preset");
    this.statusEl = this.ref("status");
    this.errorEl = this.ref("error");

    this.details = new DetailsPanel(
      {
        tabs: this.ref("detail-tabs"),
        info: this.ref("commit-info"),
        fileHeader: this.ref("file-header"),
        fileList: this.ref("file-list"),
        view: this.ref("diff-view"),
        body: this.ref("details-body"),
      },
      {
        fileText: (commitId, filePath) => fetchFileText(this.path, commitId, filePath),
        treeFiles: (commitId) => fetchTreeFiles(this.path, commitId),
        selectChange: (changeId) => {
          const index = this.log?.rows.findIndex((r) => r.changeId === changeId) ?? -1;
          if (index >= 0) this.select(index);
        },
        save: (key, value) => storage(key, value),
      },
      { tab: storage("detailsTab"), changesView: storage("changesView") },
    );

    this.revsetInput.value = this.revset;
    this.syncPreset();
    this.bindEvents();
    this.applySavedSizes();
  }

  private ref<T extends HTMLElement>(name: string): T {
    return this.root.querySelector<T>(`[data-ref="${name}"]`)!;
  }

  private bindEvents() {
    this.scroller.addEventListener("scroll", () => this.render(), { passive: true });
    new ResizeObserver(() => this.render()).observe(this.ref("list"));
    this.spacer.addEventListener("mousedown", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(".row");
      if (row) this.select(Number(row.dataset.index), false);
    });
    this.ref("refresh").addEventListener("click", () => this.load({ keepPosition: true }));
    this.revsetPreset.addEventListener("change", () => {
      if (this.revsetPreset.value !== "custom") this.applyRevset(this.revsetPreset.value);
    });
    this.revsetInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.applyRevset(this.revsetInput.value);
        this.revsetInput.blur();
      } else if (event.key === "Escape") {
        this.revsetInput.value = this.revset;
        this.revsetInput.blur();
      }
    });
    this.splitter(this.ref("split-details"), this.ref("details"), "rows", "detailsHeight", 120, 0.85);
    this.splitter(this.ref("split-info"), this.ref("info-pane"), "columns", "infoWidth", 220, 0.6);
  }

  async load({ keepPosition = false } = {}) {
    if (this.loading) return;
    this.loading = true;
    const previousChange = this.log && this.selected >= 0 ? this.log.rows[this.selected]?.changeId : null;
    const previousScroll = this.scroller.scrollTop;
    this.statusEl.textContent = "Loading…";
    try {
      const next = await fetchLog(this.path, this.revset);
      this.errorEl.hidden = true;
      this.log = next;
      this.graph = new Graph(next.rows, next.edges);
      this.name = next.workspaceRoot.split("/").pop() || next.workspaceRoot;
      this.revsetInput.placeholder = next.defaultRevset;
      let selected = previousChange ? next.rows.findIndex((r) => r.changeId === previousChange) : -1;
      if (selected < 0 && !keepPosition) selected = next.rows.findIndex((r) => r.isWorkingCopy);
      this.selected = selected;
      this.spacer.style.height = `${next.rows.length * ROW_HEIGHT}px`;
      this.clearRows();
      this.scroller.scrollTop = keepPosition ? previousScroll : 0;
      this.updateStatus();
      this.render();
      this.scheduleDetails();
      this.onChange();
    } catch (err) {
      this.errorEl.textContent = String(err);
      this.errorEl.hidden = false;
      this.statusEl.textContent = "";
    } finally {
      this.loading = false;
    }
  }

  /** Reloads if jj has run an operation since the last load. */
  async pollForChanges() {
    if (!isTauri || !this.log || this.loading) return;
    try {
      const opId = await fetchHeadOpId(this.path);
      if (this.log && opId !== this.log.opId) await this.load({ keepPosition: true });
    } catch {
      // Errors surface on the next explicit load.
    }
  }

  /** Called when the tab is shown. */
  activate() {
    this.applySavedSizes();
    this.render();
  }

  /** Rebuilds the graph for a new device pixel ratio. */
  setDpr(dpr: number) {
    this.graph?.setDpr(dpr);
    this.clearRows();
    this.render();
  }

  focusRevset() {
    this.revsetInput.focus();
    this.revsetInput.select();
  }

  /** Handles keys for the list; returns whether the key was used. */
  handleKey(event: KeyboardEvent): boolean {
    if (document.activeElement === this.revsetInput || !this.log) return false;
    // ⌥↑/⌥↓ step through the selected commit's files.
    if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      this.details.moveFile(event.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / ROW_HEIGHT) - 1);
    const moves: Record<string, number> = {
      ArrowDown: this.selected + 1,
      ArrowUp: this.selected - 1,
      PageDown: this.selected + page,
      PageUp: this.selected - page,
      Home: 0,
      End: this.log.rows.length - 1,
    };
    if (!(event.key in moves)) return false;
    this.select(moves[event.key]);
    return true;
  }

  private updateStatus() {
    const log = this.log!;
    const count = `${log.rows.length.toLocaleString()} ${log.rows.length === 1 ? "commit" : "commits"}`;
    this.statusEl.textContent = `${count}${log.truncated ? " (truncated)" : ""} · ${log.elapsedMs} ms`;
    this.statusEl.title = `Operation ${log.opId}: ${log.opDescription}`;
  }

  private render() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderNow());
  }

  private renderNow() {
    const log = this.log;
    if (!log || !this.graph) return;
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight;
    if (height === 0) return; // Hidden tab.
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(log.rows.length - 1, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);

    for (const [index, el] of this.rendered) {
      if (index < first || index > last) {
        el.remove();
        this.rendered.delete(index);
      }
    }
    for (let i = first; i <= last; i++) {
      let el = this.rendered.get(i);
      if (!el) {
        el = document.createElement("div");
        el.className = "row";
        el.dataset.index = String(i);
        renderRow(el, log.rows[i], i, this.graph);
        this.spacer.appendChild(el);
        this.rendered.set(i, el);
      }
      el.classList.toggle("selected", i === this.selected);
    }
  }

  private clearRows() {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
  }

  private select(index: number, reveal = true) {
    const log = this.log;
    if (!log || log.rows.length === 0) return;
    const previous = this.selected;
    this.selected = Math.max(0, Math.min(log.rows.length - 1, index));
    if (this.selected !== previous) this.scheduleDetails();
    if (reveal) {
      const y = this.selected * ROW_HEIGHT;
      if (y < this.scroller.scrollTop) this.scroller.scrollTop = y;
      else if (y + ROW_HEIGHT > this.scroller.scrollTop + this.scroller.clientHeight) {
        this.scroller.scrollTop = y + ROW_HEIGHT - this.scroller.clientHeight;
      }
    }
    this.render();
  }

  private scheduleDetails() {
    clearTimeout(this.detailsTimer);
    const row = this.log && this.selected >= 0 ? this.log.rows[this.selected] : null;
    if (!row) {
      this.details.clear(this.log ? "No commit selected" : "");
      return;
    }
    const cached = this.diffCache.get(row.commitId);
    if (cached) {
      this.details.show(row, cached);
      return;
    }
    this.details.showPending(row);
    const request = ++this.detailsRequest;
    this.detailsTimer = window.setTimeout(async () => {
      try {
        const diff = await fetchDiff(this.path, row.commitId);
        this.diffCache.set(row.commitId, diff);
        if (this.diffCache.size > DIFF_CACHE_SIZE) this.diffCache.delete(this.diffCache.keys().next().value!);
        if (request === this.detailsRequest) this.details.show(row, diff);
      } catch (err) {
        if (request === this.detailsRequest) this.details.showError(String(err));
      }
    }, DETAILS_DELAY_MS);
  }

  private syncPreset() {
    const match = [...this.revsetPreset.options].find((o) => o.value === this.revset && o.value !== "custom");
    this.revsetPreset.value = match ? match.value : "custom";
  }

  private applyRevset(value: string) {
    this.revset = value.trim();
    storage(`revset:${this.path}`, this.revset || null);
    this.revsetInput.value = this.revset;
    this.syncPreset();
    this.load();
  }

  // Panel sizes are shared by all tabs, so re-read them when a tab is shown.
  private applySavedSizes() {
    const height = Number(storage("detailsHeight"));
    if (height) this.ref("details").style.height = `${height}px`;
    const width = Number(storage("infoWidth"));
    if (width) this.ref("info-pane").style.width = `${width}px`;
  }

  /** Makes a splitter resize `target` along one axis, remembering the size. */
  private splitter(
    handle: HTMLElement,
    target: HTMLElement,
    axis: "rows" | "columns",
    key: string,
    min: number,
    maxFraction: number,
  ) {
    const apply = (size: number) => {
      const container = target.parentElement!;
      const total = axis === "rows" ? container.clientHeight : container.clientWidth;
      const clamped = Math.max(min, Math.min(size, total * maxFraction));
      target.style[axis === "rows" ? "height" : "width"] = `${clamped}px`;
      return clamped;
    };

    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add(`resizing-${axis}`);
      const start = axis === "rows" ? event.clientY : event.clientX;
      const rect = target.getBoundingClientRect();
      const startSize = axis === "rows" ? rect.height : rect.width;
      // The details panel sits below its splitter, so dragging up grows it.
      const sign = axis === "rows" ? -1 : 1;
      let size = startSize;
      const move = (e: PointerEvent) => {
        const delta = (axis === "rows" ? e.clientY : e.clientX) - start;
        size = apply(startSize + sign * delta);
        this.render();
      };
      const up = () => {
        document.body.classList.remove(`resizing-${axis}`);
        handle.removeEventListener("pointermove", move);
        storage(key, String(Math.round(size)));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
    });
  }
}
