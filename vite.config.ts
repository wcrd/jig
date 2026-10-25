import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The app's version lives in tauri.conf.json, which also stamps the bundle.
const { version } = JSON.parse(readFileSync(new URL("src-tauri/tauri.conf.json", import.meta.url), "utf8"));
// The commit the build came from: git's HEAD, which jj keeps at @-.
let commit = "";
try {
  commit = execSync("git rev-parse --short=8 HEAD", { encoding: "utf8" }).trim();
} catch {}

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  // The benchmark builds with its own fixture.
  publicDir: process.env.JIG_PUBLIC_DIR || "public",
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  define: { __APP_VERSION__: JSON.stringify(version), __APP_COMMIT__: JSON.stringify(commit) },
  build: {
    target: "safari16",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
