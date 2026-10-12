// App settings: the theme and the graph's lane palette. The theme is the
// `data-theme` attribute on <html>, which the stylesheet keys off. Palettes
// are written into a style element as --lane-N, so switching either recolours
// the graph without a re-render.

import { getCurrentWindow } from "@tauri-apps/api/window";

import { isTauri, storage } from "./api";
import { escapeHtml } from "./format";

type Theme = "system" | "light" | "dark";

const THEMES: [Theme, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function savedTheme(): Theme {
  const theme = storage("theme");
  return theme === "light" || theme === "dark" ? theme : "system";
}

/** Applies the saved theme, or `theme` (saving it). */
export function applyTheme(theme?: Theme) {
  if (theme !== undefined) storage("theme", theme === "system" ? null : theme);
  const choice = theme ?? savedTheme();
  const dark = choice === "dark" || (choice === "system" && systemDark.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  // The title bar and other native parts of the window follow along.
  if (isTauri) getCurrentWindow().setTheme(choice === "system" ? null : choice).catch(() => {});
}

// Following the system means following its changes too; focus is a fallback
// for webviews that don't report the change.
const followSystem = () => {
  if (savedTheme() === "system") applyTheme();
};
systemDark.addEventListener("change", followSystem);
window.addEventListener("focus", followSystem);

interface Palette {
  id: string;
  name: string;
  description: string;
  /** Ten lane colours each; shorter sets repeat to fill them. */
  light: string[];
  dark: string[];
}

const LANES = 10;

const PALETTES: Palette[] = [
  {
    id: "default",
    name: "Default",
    description: "Bright, led by violet. No red, which is kept for conflicts.",
    light: ["#6e56cf", "#12a594", "#f76b15", "#0090ff", "#d6409f", "#46a758", "#3e63dd", "#d99a00", "#a18072", "#00a2c7"],
    dark: ["#8e7cf0", "#2ec4b2", "#ff8a3d", "#3aa8ff", "#e866b8", "#5fc075", "#6683f0", "#f2b82f", "#b89a8c", "#2bbde0"],
  },
  {
    id: "muted",
    name: "Muted",
    description: "Softer, earthy colours that sit back from the text.",
    light: ["#3b6ea5", "#c2703d", "#4f8f5f", "#8e5ea2", "#c39b1f", "#2f8f8b", "#b0607e", "#6c7bb8", "#8a6d4f", "#5a9e3a"],
    dark: ["#5f92c9", "#de8b55", "#6bb07c", "#ad7cc2", "#dcb43a", "#46b0ab", "#cc7d9a", "#8a98d6", "#a8896a", "#78bd56"],
  },
  {
    id: "colorblind",
    name: "Colour-blind safe",
    description: "The Okabe–Ito colours, distinguishable with common colour vision deficiencies.",
    light: ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00", "#b8a100"],
    dark: ["#3b9ce0", "#f0b030", "#1fc493", "#e08fbb", "#7cc8f0", "#f07a2a", "#e8d44a"],
  },
];

function palette(id: string | null): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

function laneVars(colors: string[]): string {
  return Array.from({ length: LANES }, (_, i) => `--lane-${i}: ${colors[i % colors.length]};`).join(" ");
}

/** Applies the saved palette, or `id` (saving it). */
export function applyPalette(id?: string) {
  if (id !== undefined) storage("palette", id === PALETTES[0].id ? null : id);
  const p = palette(id ?? storage("palette"));
  let style = document.getElementById("lane-palette");
  if (!style) {
    style = document.createElement("style");
    style.id = "lane-palette";
    document.head.appendChild(style);
  }
  style.textContent =
    `:root { ${laneVars(p.light)} }\n` + `:root[data-theme="dark"] { ${laneVars(p.dark)} }`;
}

export type GraphDate = "changed" | "created";

const GRAPH_DATES: [GraphDate, string][] = [
  ["changed", "Last changed"],
  ["created", "Created"],
];

let graphDateChoice: GraphDate = storage("graphDate") === "created" ? "created" : "changed";

/** Which time the graph's date column shows. */
export function graphDate(): GraphDate {
  return graphDateChoice;
}

/** Saves the graph's date column choice; open repo views re-render on the event. */
function setGraphDate(choice: GraphDate) {
  graphDateChoice = choice;
  storage("graphDate", choice === "changed" ? null : choice);
  window.dispatchEvent(new Event("graph-date-change"));
}

function swatches(colors: string[], cls: string): string {
  return `<span class="swatches ${cls}">${colors.map((c) => `<span style="background:${c}"></span>`).join("")}</span>`;
}

/** Set by vite.config.ts from tauri.conf.json and git. */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

let open: HTMLDialogElement | null = null;

export function showSettings() {
  if (open) return;
  const current = palette(storage("palette")).id;
  const theme = savedTheme();
  const dialog = document.createElement("dialog");
  open = dialog;
  dialog.className = "prompt settings";
  dialog.innerHTML =
    `<div class="prompt-title">Settings</div>` +
    `<div class="list-section">Theme</div>` +
    `<div class="theme-options">` +
    THEMES.map(([id, name]) => `<button data-theme-choice="${id}"${id === theme ? ` class="on"` : ""}>${name}</button>`).join("") +
    `</div>` +
    `<div class="list-section">Graph dates</div>` +
    `<div class="theme-options graph-date-options">` +
    GRAPH_DATES.map(([id, name]) => `<button data-graph-date="${id}"${id === graphDateChoice ? ` class="on"` : ""}>${name}</button>`).join("") +
    `</div>` +
    `<div class="list-section">Graph colours</div>` +
    `<div class="palette-options">` +
    PALETTES.map(
      (p) =>
        `<label class="palette-option"><input type="radio" name="palette" value="${p.id}"${p.id === current ? " checked" : ""}>` +
        `<span class="palette-text"><span class="palette-name">${escapeHtml(p.name)}</span>` +
        `<span class="palette-description">${escapeHtml(p.description)}</span></span>` +
        swatches(p.light, "light") +
        swatches(p.dark, "dark") +
        `</label>`,
    ).join("") +
    `</div><div class="prompt-buttons"><span class="settings-version">Jig ${escapeHtml(__APP_VERSION__)}${__APP_COMMIT__ ? ` (${escapeHtml(__APP_COMMIT__)})` : ""}</span>` +
    `<button class="primary" autofocus>Done</button></div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === "palette") applyPalette(input.value);
  });
  dialog.addEventListener("click", (event) => {
    const dateButton = (event.target as HTMLElement).closest<HTMLElement>("[data-graph-date]");
    if (dateButton) {
      setGraphDate(dateButton.dataset.graphDate as GraphDate);
      for (const b of dialog.querySelectorAll(".graph-date-options button")) b.classList.toggle("on", b === dateButton);
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-theme-choice]");
    if (!button) return;
    applyTheme(button.dataset.themeChoice as Theme);
    for (const b of dialog.querySelectorAll(".theme-options button")) b.classList.toggle("on", b === button);
  });
  dialog.querySelector(".prompt-buttons button")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    dialog.remove();
    open = null;
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.showModal();
}
