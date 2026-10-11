// Syntax highlighting with highlight.js, split into per-line segments so it
// can be combined with diff lines and word-level changes.

import hljs from "highlight.js/lib/common";

/** A run of text and its highlight.js classes ("" for plain text). */
export type Segment = [cls: string, text: string];

const EXTENSIONS: Record<string, string> = {
  rs: "rust",
  swift: "swift",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  m: "objectivec",
  mm: "objectivec",
  cs: "csharp",
  php: "php",
  lua: "lua",
  pl: "perl",
  r: "r",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  json: "json",
  jsonc: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  md: "markdown",
  markdown: "markdown",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  mk: "makefile",
  diff: "diff",
  patch: "diff",
};

const FILENAMES: Record<string, string> = {
  Makefile: "makefile",
  Dockerfile: "bash",
  "Package.resolved": "json",
  "Cargo.lock": "ini",
  ".gitignore": "bash",
};

export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (FILENAMES[name]) return FILENAMES[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Highlights text, returning segments per line. */
export function highlightLines(text: string, language: string): Segment[][] {
  const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  const template = document.createElement("template");
  template.innerHTML = html;

  const lines: Segment[][] = [[]];
  const walk = (node: Node, classes: string) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = child.textContent!.split("\n");
        parts.forEach((part, i) => {
          if (i > 0) lines.push([]);
          if (part) lines[lines.length - 1].push([classes, part]);
        });
      } else if (child instanceof Element) {
        const cls = child.getAttribute("class") ?? "";
        walk(child, classes ? `${classes} ${cls}` : cls);
      }
    }
  };
  walk(template.content, "");
  return lines;
}

// Whole-file results, keyed by the object holding the text so they're
// dropped along with it.
const fileCache = new WeakMap<object, Segment[][] | null>();

export function highlightCached(key: object, text: string, language: string | null): Segment[][] | null {
  if (!language) return null;
  if (!fileCache.has(key)) {
    let result: Segment[][] | null = null;
    try {
      result = highlightLines(text, language);
    } catch {
      // Unknown language or a highlighter failure: show plain text.
    }
    fileCache.set(key, result);
  }
  return fileCache.get(key)!;
}
