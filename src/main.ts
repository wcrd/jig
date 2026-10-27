// Starts the window: the theme, the App component and its tabs.

import { flushSync, mount } from "svelte";

import App from "./components/App.svelte";
import { applyPalette, applyTheme } from "./settings";
import { start } from "./tabs.svelte";

applyTheme();
applyPalette();
mount(App, { target: document.body });
// Draw it before the tabs open, so their views have somewhere to go.
flushSync();
start();
