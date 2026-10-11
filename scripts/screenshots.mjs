// Captures the README screenshots by driving headless Chrome over CDP
// against the browser preview (`npm run dev` with a playground fixture).
// See DEVELOPMENT.md for the steps list used.
//
//   node scripts/screenshots.mjs <out dir> [light|dark] '<steps JSON>'
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [, , outDir, scheme = "light"] = process.argv;
const PORT = 9333;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "jig-shots-"))}`, "--hide-scrollbars", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }).then((m) => { if (m.error) throw new Error(method + ": " + m.error.message); return m.result; });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const W = 1400, H = 860;
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
await send("Page.navigate", { url: "http://localhost:1420/" });
await sleep(2000);
async function click(selector, text) {
  const pt = await evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.offsetParent !== null);
    const el = ${text ? `els.filter(e => e.textContent.includes(${JSON.stringify(text)})).sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0]` : "els[0]"}; if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 }; })()`);
  if (!pt) throw new Error(`not found: ${selector} ${text ?? ""}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  await sleep(700);
}
async function shot(name) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: W - 2, y: H - 2 });
  await sleep(400);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const fs = await import("node:fs"); fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, "base64")); console.log("wrote", name);
}
const steps = JSON.parse(process.argv[4] ?? "[]");
try {
  for (const s of steps) { if (s.click) await click(s.click, s.text); if (s.eval) console.log(await evaluate(s.eval)); if (s.wait) await sleep(s.wait); if (s.shot) await shot(s.shot); }
} finally { ws.close(); chrome.kill(); }
