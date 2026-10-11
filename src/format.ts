// Formatting helpers for the commit list.

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Dates read "Today at 8:06 PM", "Jul 14, 2026 at 3:06 PM". */
export function formatDate(millis: number, now = new Date()): string {
  const date = new Date(millis);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  const prefix = days === 0 ? "Today" : days === 1 ? "Yesterday" : day.format(date);
  return `${prefix} at ${time.format(date)}`;
}

export function formatFullDate(millis: number): string {
  return new Date(millis).toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" });
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** A stable hue for an author, so their avatar colour is consistent. */
export function avatarHue(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/** Splits a conventional-commit prefix ("feat(store):") off a summary. */
export function splitConventional(summary: string): [string, string] {
  const match = /^([\w-]+(?:\([^)]*\))?!?:)(\s.*)$/.exec(summary);
  return match ? [match[1], match[2]] : ["", summary];
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Joins hard-wrapped lines of a commit message into paragraphs so it can use
 * the available width. Blank lines, list items, indented (code) lines and
 * trailers like "Co-Authored-By:" keep their own lines.
 */
export function reflowMessage(text: string): string {
  const keepsLine = (line: string) =>
    line.trim() === "" ||
    /^\s/.test(line) ||
    /^([-*+]|\d+[.)])\s/.test(line) ||
    /^[A-Za-z][\w-]*: \S/.test(line) ||
    line.startsWith("```");
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const previous = out[out.length - 1];
    if (previous !== undefined && previous.trim() !== "" && !keepsLine(line) && !/^\s/.test(previous) && !previous.startsWith("```")) {
      out[out.length - 1] = `${previous} ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}
