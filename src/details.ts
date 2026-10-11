// The panel under the graph: commit details and changed files on the left,
// the selected file's diff on the right.

import { avatarHue, escapeHtml, formatFullDate, initials } from "./format";
import type { CommitDiff, DiffLine, FileDiff, FileStatus, LogRow } from "./types";

const STATUS_LETTER: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

export interface DetailsCallbacks {
  /** Select a commit in the graph by change ID, e.g. when a parent is clicked. */
  selectChange(changeId: string): void;
}

export class DetailsPanel {
  private diff: CommitDiff | null = null;
  private row: LogRow | null = null;
  private fileIndex = 0;

  constructor(
    private info: HTMLElement,
    private fileHeader: HTMLElement,
    private fileList: HTMLElement,
    private diffView: HTMLElement,
    callbacks: DetailsCallbacks,
  ) {
    fileList.addEventListener("mousedown", (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>(".file");
      if (item) this.selectFile(Number(item.dataset.index));
    });
    info.addEventListener("click", (event) => {
      const parent = (event.target as HTMLElement).closest<HTMLElement>("[data-change]");
      if (parent) callbacks.selectChange(parent.dataset.change!);
    });
  }

  clear(message = "") {
    this.diff = null;
    this.row = null;
    this.info.innerHTML = message ? `<div class="placeholder-text">${escapeHtml(message)}</div>` : "";
    this.fileHeader.textContent = "";
    this.fileList.innerHTML = "";
    this.diffView.innerHTML = "";
  }

  /** Shows the row's header straight away, before its diff has loaded. */
  showPending(row: LogRow) {
    if (this.row?.commitId === row.commitId) return;
    this.row = row;
    this.diff = null;
    this.info.innerHTML = this.infoHtml(row, null);
    this.fileHeader.textContent = "Changes";
    this.fileList.innerHTML = "";
    this.diffView.innerHTML = "";
  }

  show(row: LogRow, diff: CommitDiff) {
    const previousPath = this.diff?.files[this.fileIndex]?.path;
    this.row = row;
    this.diff = diff;
    this.info.innerHTML = this.infoHtml(row, diff);
    const found = previousPath ? diff.files.findIndex((f) => f.path === previousPath) : -1;
    this.fileIndex = found >= 0 ? found : 0;
    this.renderFiles();
    this.renderDiff();
  }

  showError(message: string) {
    this.diffView.innerHTML = `<div class="placeholder-text error-text">${escapeHtml(message)}</div>`;
  }

  /** Moves the file selection, for keyboard navigation. */
  moveFile(delta: number) {
    if (!this.diff || this.diff.files.length === 0) return;
    this.selectFile(Math.max(0, Math.min(this.diff.files.length - 1, this.fileIndex + delta)));
  }

  private selectFile(index: number) {
    if (!this.diff || index === this.fileIndex) return;
    this.fileIndex = index;
    for (const el of this.fileList.querySelectorAll(".file")) {
      el.classList.toggle("selected", Number((el as HTMLElement).dataset.index) === index);
    }
    this.fileList.querySelector(".file.selected")?.scrollIntoView({ block: "nearest" });
    this.renderDiff();
  }

  private infoHtml(row: LogRow, diff: CommitDiff | null): string {
    const description = diff?.description ?? row.summary;
    const [summary, ...rest] = description.split("\n");
    const body = rest.join("\n").trim();
    const author = diff?.author ?? { name: row.authorName, email: row.authorEmail, timestamp: row.timestamp };
    const committer = diff?.committer;

    let html = summary
      ? `<div class="ci-summary">${escapeHtml(summary)}</div>`
      : `<div class="ci-summary placeholder">(no description set)</div>`;
    if (body) html += `<div class="ci-body">${escapeHtml(body)}</div>`;

    html += `<div class="ci-person">
      <span class="avatar large" style="--hue:${avatarHue(author.email || author.name)}">${escapeHtml(initials(author.name))}</span>
      <div><div><b>${escapeHtml(author.name)}</b> <span class="muted">&lt;${escapeHtml(author.email)}&gt;</span></div>
      <div class="muted">${escapeHtml(formatFullDate(author.timestamp))}</div></div></div>`;

    html += `<dl class="ci-meta">`;
    if (committer && (committer.email !== author.email || committer.name !== author.name)) {
      html += `<dt>Committer</dt><dd>${escapeHtml(committer.name)} <span class="muted">&lt;${escapeHtml(committer.email)}&gt;</span></dd>`;
    }
    if (committer && committer.timestamp !== author.timestamp) {
      html += `<dt>Committed</dt><dd>${escapeHtml(formatFullDate(committer.timestamp))}</dd>`;
    }
    html += `<dt>Change</dt><dd class="mono"><span class="id change-id"><b>${row.changeId.slice(0, row.changePrefixLen)}</b>${row.changeId.slice(row.changePrefixLen)}</span></dd>`;
    html += `<dt>Commit</dt><dd class="mono"><span class="id commit-id"><b>${row.commitId.slice(0, row.commitPrefixLen)}</b>${row.commitId.slice(row.commitPrefixLen)}</span></dd>`;
    if (diff && diff.parents.length > 0) {
      html += `<dt>${diff.parents.length > 1 ? "Parents" : "Parent"}</dt><dd>`;
      for (const parent of diff.parents) {
        html += `<div class="ci-parent" data-change="${parent.changeId}" title="Select ${parent.changeId.slice(0, 8)}">
          <span class="id change-id">${parent.changeId.slice(0, 8)}</span>
          <span class="ci-parent-summary">${parent.summary ? escapeHtml(parent.summary) : '<span class="placeholder">(no description set)</span>'}</span></div>`;
      }
      html += `</dd>`;
    }
    html += `</dl>`;
    return html;
  }

  private renderFiles() {
    const files = this.diff!.files;
    const additions = files.reduce((n, f) => n + f.additions, 0);
    const deletions = files.reduce((n, f) => n + f.deletions, 0);
    this.fileHeader.innerHTML =
      `<span>${files.length} ${files.length === 1 ? "file" : "files"} changed</span>` +
      (files.length ? `<span class="stats"><span class="add">+${additions}</span> <span class="del">−${deletions}</span></span>` : "");
    if (files.length === 0) {
      // jj diffs a merge against its auto-merged parents, so a clean merge
      // has no changes of its own.
      const message = this.diff!.parents.length > 1 ? "Clean merge: no changes beyond its parents" : "No changes";
      this.fileList.innerHTML = `<div class="placeholder-text">${message}</div>`;
      return;
    }
    this.fileList.innerHTML = files
      .map((file, i) => {
        const slash = file.path.lastIndexOf("/");
        const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
        const name = file.path.slice(slash + 1);
        const stats = file.binary
          ? `<span class="muted">bin</span>`
          : file.omitted
            ? ""
            : `<span class="add">+${file.additions}</span> <span class="del">−${file.deletions}</span>`;
        const title = file.sourcePath ? `${file.sourcePath} → ${file.path}` : file.path;
        return `<div class="file${i === this.fileIndex ? " selected" : ""}" data-index="${i}" title="${escapeHtml(title)}">
          <span class="status ${file.status}${file.conflict ? " conflict" : ""}">${file.conflict ? "!" : STATUS_LETTER[file.status]}</span>
          <span class="path"><span class="name">${escapeHtml(name)}</span><span class="dir">${escapeHtml(dir)}</span></span>
          <span class="stats">${stats}</span></div>`;
      })
      .join("");
  }

  private renderDiff() {
    const file = this.diff?.files[this.fileIndex];
    if (!file) {
      this.diffView.innerHTML = "";
      return;
    }
    this.diffView.innerHTML = fileHeaderHtml(file) + `<div class="diff-body">${fileBodyHtml(file)}</div>`;
    this.diffView.scrollTop = 0;
    this.diffView.scrollLeft = 0;
  }
}

function fileHeaderHtml(file: FileDiff): string {
  const rename = file.sourcePath
    ? `<span class="muted">${escapeHtml(file.sourcePath)} → </span>`
    : "";
  return `<div class="diff-header"><span class="status ${file.status}${file.conflict ? " conflict" : ""}">${file.conflict ? "!" : STATUS_LETTER[file.status]}</span>
    <span class="diff-path">${rename}${escapeHtml(file.path)}</span>
    ${file.conflict ? `<span class="pill flag conflict"><span class="label">conflict</span></span>` : ""}</div>`;
}

function fileBodyHtml(file: FileDiff): string {
  if (file.binary) return `<div class="placeholder-text">Binary file not shown</div>`;
  if (file.omitted) return `<div class="placeholder-text">Diff too large to show</div>`;
  if (file.hunks.length === 0) {
    return `<div class="placeholder-text">${file.status === "added" || file.status === "deleted" ? "Empty file" : "No content changes"}</div>`;
  }
  let html = `<div class="diff-lines">`;
  for (const hunk of file.hunks) {
    html += `<div class="line hunk"><span class="no"></span><span class="no"></span><span class="code">@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@</span></div>`;
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const line of hunk.lines) {
      const left = line.kind === "+" ? "" : String(oldNo++);
      const right = line.kind === "-" ? "" : String(newNo++);
      html += lineHtml(line, left, right);
    }
  }
  return html + `</div>`;
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
