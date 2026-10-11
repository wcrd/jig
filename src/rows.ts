// Builds the DOM for one commit row: description with ref pills, then the
// author, change ID, commit ID and date columns.

import { avatarHue, escapeHtml, formatDate, formatFullDate, initials, splitConventional } from "./format";
import { ROW_HEIGHT, laneColor, textX, type Graph } from "./graph";
import type { LogRow, RefLabel } from "./types";

const CLOUD_ICON = `<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4.5 12.5h7a3 3 0 0 0 .4-6 4 4 0 0 0-7.7.9A2.6 2.6 0 0 0 4.5 12.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const TAG_ICON = `<svg viewBox="0 0 16 16" width="11" height="11"><path d="M2.5 2.5h5.2l6 6-5.2 5.2-6-6zM5.3 5.3h.01" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

function pill(label: string, opts: { icon?: string; color?: string; kind: string; title?: string }): string {
  const style = opts.color ? ` style="--pill: ${opts.color}"` : "";
  const title = opts.title ? ` title="${escapeHtml(opts.title)}"` : "";
  const tile = opts.icon ? `<span class="tile">${opts.icon}</span>` : "";
  return `<span class="pill ${opts.kind}"${style}${title}>${tile}<span class="label">${label}</span></span>`;
}

function refPill(ref: RefLabel, color: string): string {
  switch (ref.type) {
    case "bookmark": {
      let label = escapeHtml(ref.name);
      if (ref.conflict) label += "??";
      else if (ref.tracked && !ref.synced) label += `<span class="unsynced">*</span>`;
      const title = ref.conflict
        ? "Conflicted bookmark"
        : !ref.tracked
          ? "Local bookmark (not tracking a remote)"
          : ref.synced
            ? "Bookmark, in sync with its remote"
            : "Bookmark, differs from its remote";
      return pill(label, {
        kind: ref.conflict ? "bookmark conflict" : "bookmark",
        color,
        icon: ref.tracked && ref.synced ? CLOUD_ICON : undefined,
        title,
      });
    }
    case "remoteBookmark":
      return pill(`${escapeHtml(ref.name)}@${escapeHtml(ref.remote)}`, {
        kind: ref.tracked ? "remote" : "remote untracked",
        color,
        icon: CLOUD_ICON,
        title: ref.tracked ? "Remote bookmark" : "Untracked remote bookmark",
      });
    case "tag":
      return pill(escapeHtml(ref.name), { kind: "tag", icon: TAG_ICON, title: "Tag" });
  }
}

function idHtml(id: string, prefixLen: number, kind: string): string {
  const shown = Math.max(8, prefixLen);
  return `<span class="id ${kind}"><b>${id.slice(0, prefixLen)}</b>${id.slice(prefixLen, shown)}</span>`;
}

export function renderRow(el: HTMLElement, row: LogRow, index: number, graph: Graph) {
  const color = laneColor(row.lane);
  el.style.top = `${index * ROW_HEIGHT}px`;
  el.classList.toggle("dim", !row.inWcHistory);
  el.classList.toggle("wc", row.isWorkingCopy);

  let pills = "";
  if (row.isWorkingCopy) pills += pill("@", { kind: "workspace current", color, title: "Working copy" });
  for (const name of row.workspaces) {
    pills += pill(`${escapeHtml(name)}@`, { kind: "workspace", title: `Working copy of workspace ${name}` });
  }
  for (const ref of row.refs) pills += refPill(ref, color);
  if (row.conflict) pills += pill("conflict", { kind: "flag conflict" });
  if (row.divergent) pills += pill("divergent", { kind: "flag divergent" });

  let summary: string;
  if (row.summary) {
    const [prefix, rest] = splitConventional(row.summary);
    summary = (prefix ? `<b>${escapeHtml(prefix)}</b>` : "") + escapeHtml(rest);
  } else {
    summary = `<span class="placeholder">(no description set)</span>`;
  }
  // Merges are usually "empty" (no changes beyond their parents), which is noise.
  const empty = row.empty && row.parentCount < 2 ?`<span class="empty-tag">(empty)</span> ` : "";
  const body = row.hasBody ? `<span class="more" title="Has a longer description">↩</span>` : "";

  el.innerHTML =
    graph.rowSvg(index) +
    `<div class="desc" style="padding-left:${textX(row.width)}px">${pills}` +
    `<span class="summary">${empty}${summary}</span>${body}</div>` +
    `<div class="author" title="${escapeHtml(`${row.authorName} <${row.authorEmail}>`)}">` +
    `<span class="avatar" style="--hue:${avatarHue(row.authorEmail || row.authorName)}">${escapeHtml(initials(row.authorName))}</span>` +
    `<span class="name">${escapeHtml(row.authorName)}</span></div>` +
    `<div class="change" title="Change ID ${row.changeId}">${idHtml(row.changeId, row.changePrefixLen, "change-id")}</div>` +
    `<div class="commit" title="Commit ID ${row.commitId}">${idHtml(row.commitId, row.commitPrefixLen, "commit-id")}</div>` +
    `<div class="date" title="${escapeHtml(formatFullDate(row.timestamp))}">${escapeHtml(formatDate(row.timestamp))}</div>`;
}
