// A three-way merge editor for resolving a conflicted file: the two sides
// with the result between them (or stacked), block by block. Clean regions
// are already merged; each conflict block takes a side with » / «, both in
// either order, the base, or hand-edited text.

import { escapeHtml } from "./format";
import { type MenuEntry, showMenu } from "./ui";

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

/** Long clean regions are folded to this many lines at each end. */
const FOLD_CONTEXT = 3;

/** Text without its final newline, for display in a block. */
const display = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text);
const lineCount = (text: string) => (text === "" ? 0 : display(text).split("\n").length);

export class MergeEditor {
  /** For each conflict hunk, the chosen result text, or null while unresolved. */
  private choices: (string | null)[];
  private unfolded = new Set<number>();
  private root!: HTMLElement;

  constructor(
    private container: HTMLElement,
    private path: string,
    private file: ConflictFile,
    private layout: MergeLayout,
    private callbacks: MergeCallbacks,
  ) {
    this.choices = file.hunks.map(() => null);
    this.render();
  }

  /** Moves focus to the next or previous unresolved conflict (n / p). */
  jump(delta: 1 | -1) {
    const blocks = [...this.root.querySelectorAll<HTMLElement>(".mblock.conflict")];
    if (blocks.length === 0) return;
    const body = this.root.querySelector<HTMLElement>(".merge-body")!;
    const top = body.scrollTop;
    const ordered = delta > 0 ? blocks : [...blocks].reverse();
    const next =
      ordered.find((b) => (delta > 0 ? b.offsetTop > top + 4 : b.offsetTop < top - 4) && b.classList.contains("unresolved")) ??
      ordered.find((b) => b.classList.contains("unresolved")) ??
      ordered[0];
    body.scrollTop = next.offsetTop - 12;
  }

  private conflictCount() {
    return this.file.hunks.filter((h) => h.kind === "conflict").length;
  }

  private unresolvedCount() {
    return this.file.hunks.filter((h, i) => h.kind === "conflict" && this.choices[i] === null).length;
  }

  private result(): string {
    return this.file.hunks.map((h, i) => (h.kind === "resolved" ? h.text : (this.choices[i] ?? ""))).join("");
  }

  private render() {
    const [left, right] = this.file.labels;
    this.container.innerHTML = `<div class="merge ${this.layout}">
      <div class="merge-header">
        <span class="status modified conflict">!</span><span class="diff-path">${escapeHtml(this.path)}</span>
        <span class="merge-count"></span>
        <span class="header-buttons">
          <button class="header-button" data-action="prev" title="Previous conflict (p)">↑</button>
          <button class="header-button" data-action="next" title="Next conflict (n)">↓</button>
          <button class="header-button text" data-action="layout" title="Switch between side-by-side and stacked">${this.layout === "columns" ? "Stacked" : "Side by Side"}</button>
          <button class="header-button text" data-action="more" title="Take a whole side">Take All…</button>
          <button class="header-button text" data-action="cancel">Cancel</button>
          <button class="header-button text primary" data-action="resolve">Mark Resolved</button>
        </span>
      </div>
      <div class="merge-labels"><span class="mlabel left" title="${escapeHtml(left ?? "")}">${escapeHtml(left ?? "Side 1")}</span><span class="mlabel result">Result</span><span class="mlabel right" title="${escapeHtml(right ?? "")}">${escapeHtml(right ?? "Side 2")}</span></div>
      <div class="merge-body">${this.file.hunks.map((h, i) => this.blockHtml(h, i)).join("")}</div>
    </div>`;
    this.root = this.container.querySelector(".merge")!;
    this.bind();
    this.updateCount();
  }

  private blockHtml(hunk: ConflictHunk, index: number): string {
    if (hunk.kind === "resolved") {
      const lines = display(hunk.text).split("\n");
      let text = display(hunk.text);
      let fold = "";
      if (lines.length > FOLD_CONTEXT * 2 + 2 && !this.unfolded.has(index)) {
        const hidden = lines.length - FOLD_CONTEXT * 2;
        text = lines.slice(0, FOLD_CONTEXT).join("\n");
        fold = `<button class="mfold" data-unfold="${index}">⋯ ${hidden} unchanged lines</button>`;
        const tail = lines.slice(-FOLD_CONTEXT).join("\n");
        const pre = (cls: string) =>
          `<div class="mcell ${cls}"><pre>${escapeHtml(text)}</pre>${fold}<pre>${escapeHtml(tail)}</pre></div>`;
        return `<div class="mblock resolved">${pre("left")}${pre("result")}${pre("right")}</div>`;
      }
      const cell = (cls: string) => `<div class="mcell ${cls}"><pre>${escapeHtml(text)}</pre></div>`;
      return `<div class="mblock resolved">${cell("left")}${cell("result")}${cell("right")}</div>`;
    }
    const [leftText = "", rightText = ""] = hunk.sides;
    const choice = this.choices[index];
    const rows = Math.max(1, lineCount(choice ?? ""), lineCount(leftText), lineCount(rightText));
    return `<div class="mblock conflict${choice === null ? " unresolved" : ""}" data-hunk="${index}">
      <div class="mcell left"><button class="mtake" data-take="left" title="Use this side">»</button><pre>${escapeHtml(display(leftText)) || '<span class="muted">(nothing)</span>'}</pre></div>
      <div class="mcell result">
        <div class="mresult-tools"><button class="mmenu" data-menu="${index}" title="More choices">⋯</button></div>
        <textarea spellcheck="false" autocapitalize="off" autocorrect="off" rows="${rows}" placeholder="Take a side with » or «, or type the result">${escapeHtml(display(choice ?? ""))}</textarea>
      </div>
      <div class="mcell right"><button class="mtake" data-take="right" title="Use this side">«</button><pre>${escapeHtml(display(rightText)) || '<span class="muted">(nothing)</span>'}</pre></div>
    </div>`;
  }

  private bind() {
    this.root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "next" || action === "prev") return this.jump(action === "next" ? 1 : -1);
      if (action === "layout") {
        this.layout = this.layout === "columns" ? "stacked" : "columns";
        this.callbacks.layoutChanged(this.layout);
        return this.render();
      }
      if (action === "more") {
        return showMenu([
          { text: `Take All of “${this.file.labels[0] ?? "Side 1"}”`, action: () => this.callbacks.takeSide("ours") },
          { text: `Take All of “${this.file.labels[1] ?? "Side 2"}”`, action: () => this.callbacks.takeSide("theirs") },
        ]);
      }
      if (action === "cancel") return this.callbacks.cancel();
      if (action === "resolve") {
        if (this.unresolvedCount() === 0) this.callbacks.resolve(this.result());
        return;
      }
      const unfold = target.closest<HTMLElement>("[data-unfold]");
      if (unfold) {
        this.unfolded.add(Number(unfold.dataset.unfold));
        return this.rerenderBody();
      }
      const block = target.closest<HTMLElement>(".mblock.conflict");
      if (!block) return;
      const index = Number(block.dataset.hunk);
      const hunk = this.file.hunks[index] as Extract<ConflictHunk, { kind: "conflict" }>;
      const take = target.closest<HTMLElement>("[data-take]")?.dataset.take;
      if (take) return this.choose(index, hunk.sides[take === "left" ? 0 : 1] ?? "");
      if (target.closest("[data-menu]")) {
        const [l = "", r = ""] = hunk.sides;
        const entries: MenuEntry[] = [
          { text: "Take Left", action: () => this.choose(index, l) },
          { text: "Take Right", action: () => this.choose(index, r) },
          { text: "Both, Left First", action: () => this.choose(index, joinBlocks(l, r)) },
          { text: "Both, Right First", action: () => this.choose(index, joinBlocks(r, l)) },
          { text: `Take ${this.file.baseLabel}`, action: () => this.choose(index, hunk.base[0] ?? "") },
          "separator",
          { text: "Clear", action: () => this.choose(index, null) },
        ];
        showMenu(entries);
      }
    });
    this.root.addEventListener("input", (event) => {
      const textarea = event.target as HTMLTextAreaElement;
      const block = textarea.closest<HTMLElement>(".mblock.conflict");
      if (!block) return;
      const index = Number(block.dataset.hunk);
      // Typed text is kept as written; the file's own line ending follows it.
      const value = textarea.value;
      this.choices[index] = value === "" ? "" : value.endsWith("\n") ? value : `${value}\n`;
      block.classList.remove("unresolved");
      textarea.rows = Math.max(1, lineCount(value));
      this.updateCount();
    });
    this.root.addEventListener("keydown", (event) => {
      if ((event.target as HTMLElement).tagName === "TEXTAREA") return;
      if (event.key === "n" || event.key === "p") {
        event.preventDefault();
        event.stopPropagation();
        this.jump(event.key === "n" ? 1 : -1);
      }
    });
  }

  private choose(index: number, text: string | null) {
    this.choices[index] = text;
    const block = this.root.querySelector<HTMLElement>(`.mblock[data-hunk="${index}"]`);
    if (block) {
      const textarea = block.querySelector("textarea")!;
      textarea.value = text === null ? "" : display(text);
      textarea.rows = Math.max(1, lineCount(text ?? ""));
      block.classList.toggle("unresolved", text === null);
    }
    this.updateCount();
  }

  private rerenderBody() {
    const body = this.root.querySelector<HTMLElement>(".merge-body")!;
    const top = body.scrollTop;
    body.innerHTML = this.file.hunks.map((h, i) => this.blockHtml(h, i)).join("");
    body.scrollTop = top;
  }

  private updateCount() {
    const total = this.conflictCount();
    const left = this.unresolvedCount();
    this.root.querySelector(".merge-count")!.textContent =
      left === 0 ? `All ${total} ${total === 1 ? "conflict" : "conflicts"} resolved` : `${left} of ${total} ${total === 1 ? "conflict" : "conflicts"} left`;
    // jj refuses to resolve a file to nothing, so an empty result can't be saved.
    const empty = left === 0 && this.result() === "";
    const button = this.root.querySelector<HTMLButtonElement>("[data-action='resolve']")!;
    button.disabled = left > 0 || empty;
    button.title = empty ? "jj can't resolve a file to empty content" : "";
  }
}

/** Two blocks one after the other, keeping a line break between them. */
function joinBlocks(first: string, second: string): string {
  if (first === "" || first.endsWith("\n")) return first + second;
  return `${first}\n${second}`;
}
