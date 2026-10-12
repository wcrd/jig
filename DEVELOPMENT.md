# Development

## Prerequisites

- Rust (2024 edition) and Node
- `jj` 0.40 — `jj-lib` and `jj-cli` are pinned to the installed CLI so on-disk repo formats agree

## Layout

- `src/` — TypeScript frontend (no framework), built with Vite
- `src-tauri/src/` — Rust backend: log loading and lane layout (`repo.rs`, `layout.rs`), diffs (`diff.rs`), conflicts (`conflict.rs`), and repository changes run through the user's `jj` (`jj_cli.rs`)
- `src-tauri/examples/` — `fixture` and `dump` helpers for working without the app
- `scripts/` — playground repo and screenshot helpers

## Running the app

```bash
npm install
```

```bash
npm run tauri dev
```

Jig opens the repo given as its first argument, then `$JIG_REPO`, then the current directory. Under `tauri dev` the environment variable is easiest:

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

## Screenshots

The README screenshots come from the browser preview with the playground fixture, captured by headless Chrome. With `npm run dev` running:

```bash
node scripts/screenshots.mjs docs/screenshots light '[{"click":"*","text":"Sidebar: add items"},{"click":".file-list .tree-row.file","text":"sidebar.rs"},{"shot":"main"},{"click":"*","text":"Merge the style changes"},{"click":"button","text":"Resolve…"},{"wait":500},{"shot":"resolve"},{"eval":"document.dispatchEvent(new KeyboardEvent(\"keydown\",{key:\"Escape\",bubbles:true}))"},{"click":"[data-ref=oplog-button]"},{"wait":500},{"shot":"oplog"}]'
```

Shots are 2× scale (2800×1720); the committed copies are downscaled to 2000px wide with `sips -Z 2000`.
