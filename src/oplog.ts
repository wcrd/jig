// The operation log: every jj operation on the repo, newest first, with
// restoring the repo to one or reverting just one.

import { type OpChanges, type OpEntry, fetchOpChanges, fetchOpLog, jj, storage } from "./api";
import { escapeHtml, formatDate, formatFullDate } from "./format";
import type { CommandOutput } from "./types";
import { confirm, showMenu } from "./ui";

export class OpLogPanel {
  private ops: OpEntry[] = [];
  private selected: string | null = null;
  private hideSnapshots = storage("opLogHideSnapshots") === "1";
  private list: HTMLElement;
  private footer: HTMLElement;
  private detail: HTMLElement;
  private detailFor: string | null = null;
  private changesCache = new Map<string, OpChanges>();

  constructor(
    private el: HTMLElement,
    private path: string,
    private act: (label: string, run: () => Promise<CommandOutput>) => Promise<void>,
    private onToggle: (visible: boolean) => void,
    /** Jump to a commit in the graph. */
    private showCommit: (commitId: string) => void,
  ) {
    el.innerHTML = `<div class="oplog-card">
        <div class="oplog-header"><span class="oplog-title">Operation Log</span>
          <label class="oplog-toggle"><input type="checkbox" data-ref="hide-snapshots" /> Hide snapshots</label>
          <button class="header-button oplog-close" data-action="close" title="Close (Esc)"><svg viewBox="0 0 10 10" width="10" height="10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>
        <div class="op op-columns"><span>Operation</span><span>ID</span><span>User</span><span>When</span></div>
        <div class="oplog-list"></div>
        <div class="oplog-detail"><div class="placeholder-text">Select an operation to see what it changed</div></div>
        <div class="oplog-footer"></div>
      </div>`;
    this.list = el.querySelector(".oplog-list")!;
    this.detail = el.querySelector(".oplog-detail")!;
    this.detail.addEventListener("click", (event) => {
      const commit = (event.target as HTMLElement).closest<HTMLElement>("[data-commit]");
      if (commit) this.showCommit(commit.dataset.commit!);
    });
    this.footer = el.querySelector(".oplog-footer")!;
    const hide = el.querySelector<HTMLInputElement>("[data-ref='hide-snapshots']")!;
    hide.checked = this.hideSnapshots;
    hide.addEventListener("change", () => {
      this.hideSnapshots = hide.checked;
      storage("opLogHideSnapshots", hide.checked ? "1" : "0");
      this.render();
    });
    el.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "close") this.hide();
      else if (action === "restore") this.restore();
      else if (action === "revert") this.revert();
    });
    this.list.addEventListener("mousedown", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-op]");
      if (!row) return;
      this.selected = row.dataset.op!;
      this.render();
    });
    this.list.addEventListener("contextmenu", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-op]");
      if (!row) return;
      event.preventDefault();
      this.selected = row.dataset.op!;
      this.render();
      const op = this.current();
      showMenu([
        { text: "Restore Repository to Here…", action: () => this.restore(), enabled: !op?.current },
        { text: "Revert This Operation…", action: () => this.revert() },
      ]);
    });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  async show() {
    this.el.hidden = false;
    this.onToggle(true);
    await this.refresh();
  }

  hide() {
    this.el.hidden = true;
    this.onToggle(false);
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  async refresh() {
    if (!this.visible) return;
    try {
      this.ops = await fetchOpLog(this.path);
      // Start on the newest operation so the details pane isn't empty.
      if (!this.selected || !this.ops.some((op) => op.id === this.selected)) this.selected = this.ops[0]?.id ?? null;
    } catch (err) {
      this.list.innerHTML = `<div class="placeholder-text error-text">${escapeHtml(String(err))}</div>`;
      return;
    }
    this.render();
  }

  private current(): OpEntry | undefined {
    return this.ops.find((op) => op.id === this.selected);
  }

  private render() {
    const ops = this.hideSnapshots ? this.ops.filter((op) => !op.snapshot || op.current) : this.ops;
    this.list.innerHTML = ops
      .map(
        (op) => {
          const command = op.args ? escapeHtml(displayCommand(op.args)) : "";
          const badge = op.current ? `<span class="op-current">current</span>` : "";
          const headline = command
            ? `<span class="op-line">${badge}<span class="op-command">${command}</span></span><span class="op-subtitle">${escapeHtml(op.description)}</span>`
            : `<span class="op-line">${badge}<span class="op-command plain">${escapeHtml(op.description)}</span></span>`;
          return `<div class="op${op.id === this.selected ? " selected" : ""}${op.snapshot ? " snapshot" : ""}" data-op="${op.id}" title="${escapeHtml(`${op.args ?? op.description}\n${op.description}\n${op.user} · ${formatFullDate(op.time)}\n${op.id}`)}">
          <span class="op-description">${headline}</span>
          <span class="id">${op.shortId}</span>
          <span class="op-user">${escapeHtml(op.user.split("@")[0])}</span>
          <span class="op-time">${escapeHtml(formatDate(op.time))}</span>
        </div>`;
        },
      )
      .join("");
    const op = this.current();
    if (op && op.id !== this.detailFor) this.loadDetail(op);
    this.footer.innerHTML = op
      ? `<button data-action="restore"${op.current ? " disabled" : ""} title="jj op restore: make the repo look exactly as it did after this operation">Restore to Here</button>` +
        `<button data-action="revert" title="jj op revert: undo just this operation's changes">Revert</button>`
      : `<span class="muted">Select an operation to restore or revert it</span>`;
  }

  private async loadDetail(op: OpEntry) {
    this.detailFor = op.id;
    let changes = this.changesCache.get(op.id);
    if (!changes) {
      this.detail.innerHTML = `<div class="placeholder-text">Loading…</div>`;
      try {
        changes = await fetchOpChanges(this.path, op.id);
      } catch (err) {
        if (this.detailFor === op.id) {
          this.detail.innerHTML = `<div class="placeholder-text error-text">${escapeHtml(String(err))}</div>`;
        }
        return;
      }
      this.changesCache.set(op.id, changes);
    }
    if (this.detailFor !== op.id) return;
    this.detail.innerHTML = changesHtml(op, changes);
  }

  private async restore() {
    const op = this.current();
    if (!op || op.current) return;
    const ok = await confirm(
      `Restore the repository to how it was after "${op.description}"? Later operations stay in the log, so you can undo this too.`,
      "Restore Repository",
      "Restore",
    );
    if (ok) await this.act(`Restore to ${op.shortId}`, () => jj.opRestore(this.path, op.id));
    this.refresh();
  }

  private async revert() {
    const op = this.current();
    if (!op) return;
    const ok = await confirm(`Revert just the changes made by "${op.description}"?`, "Revert Operation", "Revert");
    if (ok) await this.act(`Revert ${op.shortId}`, () => jj.opRevert(this.path, op.id));
    this.refresh();
  }
}

const KIND_LABELS = { added: "New", removed: "Abandoned", rewritten: "Rewritten" };

const short = (id: string | null) => (id ? `<span class="id">${id.slice(0, 8)}</span>` : `<span class="muted">—</span>`);

/** The "What changed" pane for an operation. */
function changesHtml(op: OpEntry, changes: OpChanges): string {
  const sections: string[] = [];
  if (changes.changes.length > 0) {
    sections.push(
      `<div class="opd-section">Changes</div>` +
        changes.changes
          .map(
            (c) =>
              `<div class="opd-row" data-commit="${c.commitId}" title="Show in graph">` +
              `<span class="opd-kind ${c.kind}">${KIND_LABELS[c.kind]}</span>` +
              `<span class="id change-id">${c.changeId.slice(0, 8)}</span>` +
              `<span class="opd-summary">${c.summary ? escapeHtml(c.summary) : `<span class="placeholder">(no description set)</span>`}${c.empty ? ` <span class="muted">(empty)</span>` : ""}</span>` +
              (c.oldCommitId ? `<span class="opd-commits">${short(c.oldCommitId)} → ${short(c.commitId)}</span>` : `<span class="opd-commits">${short(c.commitId)}</span>`) +
              `</div>`,
          )
          .join("") +
        (changes.truncated ? `<div class="placeholder-text">…and more</div>` : ""),
    );
  }
  if (changes.bookmarks.length > 0) {
    sections.push(
      `<div class="opd-section">Bookmarks</div>` +
        changes.bookmarks
          .map((b) => {
            const name = b.remote ? `${b.name}@${b.remote}` : b.name;
            const what = !b.from ? "created" : !b.to ? "deleted" : "moved";
            return `<div class="opd-row"${b.to ? ` data-commit="${b.to}" title="Show in graph"` : ""}><span class="opd-kind bookmark">${what}</span><span class="opd-summary">${escapeHtml(name)}</span><span class="opd-commits">${short(b.from)} → ${short(b.to)}</span></div>`;
          })
          .join(""),
    );
  }
  if (changes.workingCopies.length > 0) {
    sections.push(
      `<div class="opd-section">Working copy</div>` +
        changes.workingCopies
          .map(
            (w) =>
              `<div class="opd-row"${w.to ? ` data-commit="${w.to}" title="Show in graph"` : ""}><span class="opd-kind wc">@</span><span class="opd-summary">${escapeHtml(w.workspace)}</span><span class="opd-commits">${short(w.from)} → ${short(w.to)}</span></div>`,
          )
          .join(""),
    );
  }
  const command = op.args ? displayCommand(op.args) : null;
  const title = `<div class="opd-title">What changed${command ? ` · <span class="op-command">${escapeHtml(command)}</span>` : ""}</div>`;
  return title + (sections.length ? sections.join("") : `<div class="placeholder-text">No visible changes</div>`);
}

/** Global flags that say how jj ran, not what it did (Jig passes several). */
const NOISE_FLAGS = new Set(["--no-pager", "--quiet", "--ignore-working-copy", "--no-integrate-operation"]);
const NOISE_WITH_VALUE = new Set(["--color", "-R", "--repository", "--config", "--config-file", "--at-op", "--at-operation"]);

/**
 * A command line as it reads best in the log: first line only (commit
 * messages can be long), without global flags like `--no-pager -R <path>`.
 */
export function displayCommand(args: string): string {
  const firstLine = args.split("\n")[0];
  const more = args.includes("\n") ? " …" : "";
  const words = shellWords(firstLine);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const { raw, value } = words[i];
    const flag = value.split("=")[0];
    if (NOISE_FLAGS.has(value)) continue;
    if (NOISE_WITH_VALUE.has(flag)) {
      // Skip the value too, unless it was attached with "=".
      if (!value.includes("=")) i++;
      continue;
    }
    kept.push(raw);
  }
  return kept.join(" ") + more;
}

/**
 * Splits a shell-quoted command line (jj records `--config 'user.name=A B'`)
 * into words, keeping each word's original text for display.
 */
function shellWords(line: string): { raw: string; value: string }[] {
  const words: { raw: string; value: string }[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === " ") i++;
    if (i >= line.length) break;
    const start = i;
    let value = "";
    while (i < line.length && line[i] !== " ") {
      const c = line[i];
      if (c === "'" || c === '"') {
        const end = line.indexOf(c, i + 1);
        const close = end < 0 ? line.length : end;
        value += line.slice(i + 1, close);
        i = close + 1;
      } else if (c === "\\" && i + 1 < line.length) {
        value += line[i + 1];
        i += 2;
      } else {
        value += c;
        i++;
      }
    }
    words.push({ raw: line.slice(start, i), value });
  }
  return words;
}
