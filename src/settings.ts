// App settings: the theme, the graph's lane palette and dates, and how long
// toasts stay. The theme is the
// `data-theme` attribute on <html>, which the stylesheet keys off. Palettes
// are written into a style element as --lane-N, so switching either recolours
// the graph without a re-render.

import { getCurrentWindow } from "@tauri-apps/api/window";

import { isTauri, storage } from "./api";
import Settings from "./components/Settings.svelte";
import { openDialog } from "./dialog";

export type Theme = "system" | "light" | "dark";

export const THEMES: [Theme, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

export function savedTheme(): Theme {
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

export interface Palette {
  id: string;
  name: string;
  description: string;
  /** Ten lane colours each; shorter sets repeat to fill them. */
  light: string[];
  dark: string[];
}

const LANES = 10;

export const PALETTES: Palette[] = [
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

export function palette(id: string | null): Palette {
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

export const GRAPH_DATES: [GraphDate, string][] = [
  ["changed", "Last changed"],
  ["created", "Created"],
];

let graphDateChoice: GraphDate = storage("graphDate") === "created" ? "created" : "changed";

/** Which time the graph's date column shows. */
export function graphDate(): GraphDate {
  return graphDateChoice;
}

// Settings changed in another window.
window.addEventListener("storage", (event) => {
  if (event.key === "theme") applyTheme();
  else if (event.key === "palette") applyPalette();
  else if (event.key === "graphDate") {
    graphDateChoice = event.newValue === "created" ? "created" : "changed";
    window.dispatchEvent(new Event("graph-date-change"));
  }
});

/** Saves the graph's date column choice; open repo views re-render on the event. */
export function setGraphDate(choice: GraphDate) {
  graphDateChoice = choice;
  storage("graphDate", choice === "changed" ? null : choice);
  window.dispatchEvent(new Event("graph-date-change"));
}

export const TOAST_SECONDS = [3, 5, 8, 15];
const DEFAULT_TOAST_SECONDS = 5;

export function toastSeconds(): number {
  const seconds = Number(storage("toastSeconds"));
  return TOAST_SECONDS.includes(seconds) ? seconds : DEFAULT_TOAST_SECONDS;
}

export function setToastSeconds(seconds: number) {
  storage("toastSeconds", seconds === DEFAULT_TOAST_SECONDS ? null : String(seconds));
}

/** How long toasts that close by themselves stay, in milliseconds. */
export function toastTime(): number {
  return toastSeconds() * 1000;
}

let open = false;

export async function showSettings() {
  if (open) return;
  open = true;
  await openDialog(Settings, {});
  open = false;
}
