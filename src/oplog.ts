// The operation log: every jj operation on the repo, newest first, with
// restoring the repo to one or reverting just one.

import { type OpEntry, fetchOpLog, jj, storage } from "./api";
import { escapeHtml, formatDate, formatFullDate } from "./format";
import type { CommandOutput } from "./types";
import { confirm, showMenu } from "./ui";

export class OpLogPanel {
  private ops: OpEntry[] = [];
  private selected: string | null = null;
  private hideSnapshots = storage("opLogHideSnapshots") === "1";
  private list: HTMLElement;
  private footer: HTMLElement;

  constructor(
    private el: HTMLElement,
    private path: string,
    private act: (label: string, run: () => Promise<CommandOutput>) => Promise<void>,
  ) {
    el.innerHTML = `<div class="oplog-header"><span class="oplog-title">Operation Log</span>
        <label class="oplog-toggle"><input type="checkbox" data-ref="hide-snapshots" /> Hide snapshots</label>
        <button class="header-button" data-action="close" title="Close">×</button></div>
      <div class="oplog-list"></div><div class="oplog-footer"></div>`;
    this.list = el.querySelector(".oplog-list")!;
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
    await this.refresh();
  }

  hide() {
    this.el.hidden = true;
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  async refresh() {
    if (!this.visible) return;
    try {
      this.ops = await fetchOpLog(this.path);
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
        (op) => `<div class="op${op.id === this.selected ? " selected" : ""}${op.snapshot ? " snapshot" : ""}" data-op="${op.id}" title="${escapeHtml(`${op.description}\n${op.user} · ${formatFullDate(op.time)}\n${op.id}`)}">
          <div class="op-line"><span class="op-description">${escapeHtml(op.description)}</span>${op.current ? `<span class="op-current">current</span>` : ""}</div>
          <div class="op-meta"><span class="id">${op.shortId}</span> · ${escapeHtml(formatDate(op.time))} · ${escapeHtml(op.user)}</div>
        </div>`,
      )
      .join("");
    const op = this.current();
    this.footer.innerHTML = op
      ? `<button data-action="restore"${op.current ? " disabled" : ""} title="jj op restore: make the repo look exactly as it did after this operation">Restore to Here</button>` +
        `<button data-action="revert" title="jj op revert: undo just this operation's changes">Revert</button>`
      : `<span class="muted">Select an operation to restore or revert it</span>`;
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
