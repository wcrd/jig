// Measures the UI's speed on a large repo, against a production build served
// with the bench fixture, by driving headless Chrome over CDP. Make the
// fixture first (see DEVELOPMENT.md), then compare runs before and after a
// change:
//
//   node scripts/bench.mjs [--runs 5] [--cpu 4] [--label name] [--fixture dir] [--out file.json]
//
// Each run loads the app fresh and goes through the same steps: moving the
// selection, switching tabs, scrolling the graph and opening a 20,000-line
// diff. Times are wall-clock to the next paint; "cpu" is main-thread busy
// time from Chrome's metrics. Medians across runs are printed.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const runs = Number(args.runs ?? 5);
const cpu = Number(args.cpu ?? 4);
const label = args.label ?? "current";
const fixture = resolve(args.fixture ?? join(here, "../../jig-bench/fixture"));
const PORT = 4180;
const DEBUG_PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A production build with the fixture as its public files.
const dist = mkdtempSync(join(tmpdir(), "jig-bench-"));
execFileSync("npx", ["vite", "build", "--logLevel", "error", "--outDir", dist, "--emptyOutDir"], {
  cwd: join(here, ".."),
  env: { ...process.env, JIG_PUBLIC_DIR: fixture },
  stdio: "inherit",
});
const assets = readdirSync(join(dist, "assets"));
const size = (ext) =>
  assets.filter((f) => f.endsWith(ext)).reduce((n, f) => n + gzipSync(readFileSync(join(dist, "assets", f))).length, 0);
const bundle = { jsGzipKB: +(size(".js") / 1024).toFixed(1), cssGzipKB: +(size(".css") / 1024).toFixed(1) };

const server = spawn("npx", ["vite", "preview", "--outDir", dist, "--port", String(PORT), "--strictPort"], {
  cwd: join(here, ".."),
  stdio: "ignore",
});
const chrome = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "jig-bench-chrome-"))}`, "about:blank"],
  { stdio: "ignore" },
);

let targets;
for (let i = 0; i < 50 && !targets; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
  } catch {
    await sleep(200);
  }
}
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`http://localhost:${PORT}/`);
    break;
  } catch {
    await sleep(200);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  }).then((m) => {
    if (m.error) throw new Error(`${method}: ${m.error.message}`);
    return m.result;
  });
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
/** Main-thread busy time, in ms, while `run` runs. */
async function busy(run) {
  const before = await metrics();
  const value = await run();
  const after = await metrics();
  return { value, cpuMs: (after.TaskDuration - before.TaskDuration) * 1000 };
}

// Helpers defined in the page: waiting for a condition, then for the frame after it paints.
const HELPERS = `
window.__bench = {
  paint: () => new Promise((r) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => r(performance.now()); c.port2.postMessage(0); })),
  /** Resolves once \`cond\` holds, checking whenever the DOM changes rather than polling. */
  until(cond, timeout = 20000) {
    if (cond()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (!cond()) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error("timed out waiting for " + cond));
      }, timeout);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  },
  key(key) { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); },
  selected: () => Number(document.querySelector(".row.selected")?.dataset.index ?? -1),
  summary: () => document.querySelector(".commit-info .ci-summary")?.textContent ?? "",
  /** Whether the details panel shows the selected row with its diff loaded. */
  shown() {
    const row = document.querySelector(".row.selected .change-id")?.textContent ?? "";
    const panel = document.querySelector(".detail-tabs .tab-context .change-id")?.textContent ?? "";
    return panel !== "" && row.startsWith(panel) && /changed/.test(document.querySelector(".file-header")?.textContent ?? "");
  },
  /** Moves the selection down with j, waiting for each commit's details; returns each step's ms. */
  async walk(steps) {
    const times = [];
    for (let i = 0; i < steps; i++) {
      const target = this.selected() + 1;
      const start = performance.now();
      this.key("j");
      await this.until(() => this.selected() === target && this.shown());
      times.push((await this.paint()) - start);
    }
    return times;
  },
  async scroll(el, frames, by) {
    const stamps = [];
    for (let i = 0; i < frames; i++) {
      el.scrollTop += by;
      stamps.push(await new Promise((r) => requestAnimationFrame(r)));
    }
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    return { meanFrame: gaps.reduce((a, b) => a + b, 0) / gaps.length, worstFrame: Math.max(...gaps) };
  },
};`;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

await send("Performance.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
// Headless pages can start out hidden, and hidden pages get no animation frames.
await send("Page.bringToFront");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });

const results = [];
try {
  for (let run = 0; run < runs; run++) {
    await send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await send("Page.navigate", { url: "about:blank" });
    await sleep(300);
    await send("Emulation.setCPUThrottlingRate", { rate: cpu });
    // Fresh state: no saved tabs, sizes or revsets.
    await send("Page.navigate", { url: `http://localhost:${PORT}/` });
    await evaluate(`localStorage.clear()`);
    await send("Page.reload");
    await sleep(100);
    const r = {};
    // Times since navigation started.
    const load = await evaluate(`(async () => {
      await __bench.until(() => document.querySelector(".row"));
      const rows = await __bench.paint();
      await __bench.until(() => __bench.shown());
      return { rows, details: await __bench.paint() };
    })()`);
    r.loadRowsMs = load.rows;
    r.loadDetailsMs = load.details;
    await evaluate(`new Promise((r) => setTimeout(r, 500))`);

    // Diffs load once; after that moving the selection shows them from the cache.
    await evaluate(`(async () => { __bench.key("Home"); await __bench.paint(); await __bench.walk(40); })()`);
    const select = await busy(() => evaluate(`(async () => { __bench.key("Home"); await __bench.paint(); return __bench.walk(40); })()`));
    r.selectP50Ms = median(select.value);
    r.selectP95Ms = pct(select.value, 95);
    r.selectCpuMsPerStep = select.cpuMs / 40;

    const tabs = await busy(() =>
      evaluate(`(async () => {
        const times = [];
        const tab = async (name, ready) => {
          const start = performance.now();
          document.querySelector('.detail-tabs [data-tab="' + name + '"]').click();
          await __bench.until(ready);
          times.push((await __bench.paint()) - start);
        };
        __bench.key("Home");
        await __bench.paint();
        for (let i = 0; i < 10; i++) {
          await tab("changes", () => document.querySelector(".diff-view .vlines .line, .diff-view .placeholder-text, .file-list .placeholder-text"));
          await tab("tree", () => document.querySelector(".file-list .tree-row"));
          await tab("commit", () => document.querySelector(".commit-info .ci-summary"));
          __bench.key("j");
          await __bench.paint();
        }
        return times;
      })()`),
    );
    r.tabP50Ms = median(tabs.value);
    r.tabCpuMsPerSwitch = tabs.cpuMs / tabs.value.length;

    const graph = await busy(() =>
      evaluate(`(async () => {
        const el = document.querySelector(".list .scroller");
        el.scrollTop = 0;
        await __bench.paint();
        return __bench.scroll(el, 240, 60);
      })()`),
    );
    r.graphScrollMeanFrameMs = graph.value.meanFrame;
    r.graphScrollWorstFrameMs = graph.value.worstFrame;
    r.graphScrollCpuMsPerFrame = graph.cpuMs / 240;

    // The commit that rewrote the 20,000-line file.
    const diff = await busy(() =>
      evaluate(`(async () => {
        __bench.key("Home");
        await __bench.paint();
        while (!__bench.summary().includes("Regenerate the item table")) await __bench.walk(1);
        document.querySelector('.detail-tabs [data-tab="commit"]').click();
        await __bench.paint();
        let start = performance.now();
        document.querySelector('.detail-tabs [data-tab="changes"]').click();
        await __bench.until(() => document.querySelector(".diff-view .vlines .line"));
        const open = (await __bench.paint()) - start;
        start = performance.now();
        document.querySelector('.diff-view [data-action="full"]').click();
        await __bench.until(() => (document.querySelector(".diff-view .vlines")?.offsetHeight ?? 0) > 18 * 15000);
        const full = (await __bench.paint()) - start;
        return { open, full };
      })()`),
    );
    r.bigDiffOpenMs = diff.value.open;
    r.bigDiffFullFileMs = diff.value.full;
    const diffScroll = await busy(() =>
      evaluate(`__bench.scroll(document.querySelector(".diff-view"), 240, 90)`),
    );
    r.diffScrollMeanFrameMs = diffScroll.value.meanFrame;
    r.diffScrollCpuMsPerFrame = diffScroll.cpuMs / 240;
    r.heapMB = (await metrics()).JSHeapUsedSize / 1024 / 1024;
    results.push(r);
    process.stderr.write(`run ${run + 1}/${runs} done\n`);
  }
} finally {
  ws.close();
  chrome.kill();
  server.kill();
}

const summary = { label, cpuThrottle: cpu, runs, ...bundle };
for (const key of Object.keys(results[0])) summary[key] = +median(results.map((r) => r[key])).toFixed(2);
console.table(summary);
if (args.out) writeFileSync(args.out, JSON.stringify({ summary, results }, null, 2));
