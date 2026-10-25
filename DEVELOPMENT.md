# Development

## Prerequisites

- Rust (2024 edition) and Node
- `jj` 0.40 — `jj-lib` and `jj-cli` are pinned to the installed CLI so on-disk repo formats agree

## Layout

- `src/` — the frontend, in Svelte 5 and TypeScript, built with Vite; see [Frontend](#frontend)
- `src-tauri/src/` — Rust backend: log loading and lane layout (`repo.rs`, `layout.rs`), diffs (`diff.rs`), conflicts (`conflict.rs`), and repository changes run through the user's `jj` (`jj_cli.rs`)
- `src-tauri/examples/` — `fixture` and `dump` helpers for working without the app
- `scripts/` — playground repo, benchmark and screenshot helpers

## Frontend

- Components are in `src/components/`. `App.svelte` is the window and its tabs, `RepoView.svelte` one repository, with `Sidebar`, `Details`, `OpLog`, `Resolve` and the dialogs under them.
- State and commands live in classes in `.svelte.ts` files, which components read: `Repo` (`repo.svelte.ts`) for a repository, `DetailsPanel` (`details.svelte.ts`) for the details panel, and the tabs in `tabs.svelte.ts`. Their fields are `$state`, so changing one redraws what shows it.
- Data from the backend (logs, diffs, trees) is `$state.raw`: it's replaced whole, never changed in place, so Svelte doesn't make it deeply reactive. That matters on large repos.
- Two hot paths aren't components, and are drawn directly into an element: the graph's rows (`rows.ts` and `graph.ts`, drawn by `Repo`, only those in view) and the lines of a diff or file (`diffview.ts`, drawn by `VirtualLines` in `virtual.ts`). They build markup as strings, so every piece of text from a repository goes through `escapeHtml` (`format.ts`); for new string-built markup, prefer the `html` template in `html.ts`, which escapes what's interpolated, with `setHtml`. Run the [benchmark](#benchmark) before and after changing them.
- Styles are global, in `src/styles.css`; components use its class names.
- `npm run check` runs `svelte-check`; `npm run build` runs it too and fails on warnings.

## Running the app

```bash
npm install
```

```bash
npm run tauri dev
```

Jig opens a folder macOS hands it (`open -a`, a Dock drop), then the repo given as its first argument, then `$JIG_REPO`, then the current directory. Under `tauri dev` the environment variable is easiest:

```bash
JIG_REPO=/path/to/repo npm run tauri dev
```

Build the `.app` and `.dmg` (in `src-tauri/target/release/bundle/`) for a release with:

```bash
npm run tauri build
```

Making the `.dmg` mounts it and has Finder lay out its window, which pops up on screen and can fail when Finder can't be scripted. `CI=true` skips the layout step, leaving the window's icons wherever macOS puts them:

```bash
CI=true npm run tauri build
```

If a build is interrupted, its image can stay mounted and break the next one; `hdiutil info` lists it and `hdiutil detach` ejects it.

`bundle.macOS.signingIdentity` is `"-"` so the bundle gets an ad-hoc signature carrying its identifier, `dev.wcrd.jig`. Without it the app only has the linker's signature, whose identifier is `jig-<hash>`. macOS then never matches the app to its Local Network permission, and fetches and pushes to remotes on the LAN fail with "No route to host".

## Playground repo

`scripts/make-playground.sh` builds a throwaway repo at `../jig-playground/repo` with a local remote, several authors, merges, bookmarks, a conflict, a divergent change and a second workspace. Re-run it to reset.

```bash
scripts/make-playground.sh
```

## Browser preview

`npm run dev` serves the UI at http://localhost:1420 without Tauri. Data comes from fixture files in `public/` (gitignored), written by:

```bash
cd src-tauri && cargo run --example fixture -- ../../jig-playground/repo 'all()'
```

Actions that change the repo only work in the app.

To print the backend's view of a log without any UI:

```bash
cd src-tauri && cargo run --example dump -- /path/to/repo
```

## Benchmark

`scripts/bench.mjs` times the UI on a large repo: loading, moving the selection, switching tabs, scrolling the graph and opening a 20,000-line diff, in headless Chrome with the CPU slowed 4×. It builds the app for production with its own fixture, so it doesn't touch `public/`. Make the repo (about 4,000 commits, beside the Jig checkout at `../jig-bench`) and its fixture once:

```bash
node scripts/make-bench-repo.mjs
```

```bash
cd src-tauri && JIG_FIXTURE_DIR=../../jig-bench/fixture cargo run --release --example fixture -- ../../jig-bench/repo 'all()' 60
```

Then run it before and after a change and compare the medians it prints:

```bash
node scripts/bench.mjs --runs 5 --label before --out before.json
```

Chrome isn't the WebKit view the app runs in, so treat the numbers as relative.

## Screenshots

The README screenshots come from the browser preview with the playground fixture, captured by headless Chrome. With `npm run dev` running:

```bash
node scripts/screenshots.mjs docs/screenshots light '[{"click":"*","text":"Sidebar: add items"},{"click":".file-list .tree-row.file","text":"sidebar.rs"},{"shot":"main"},{"click":"*","text":"Merge the style changes"},{"click":"button","text":"Resolve…"},{"wait":500},{"shot":"resolve"},{"eval":"document.dispatchEvent(new KeyboardEvent(\"keydown\",{key:\"Escape\",bubbles:true}))"},{"click":"[data-ref=oplog-button]"},{"wait":500},{"shot":"oplog"}]'
```

Shots are 2× scale (2800×1720); the committed copies are downscaled to 2000px wide with `sips -Z 2000`.
