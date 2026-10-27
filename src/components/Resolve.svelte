<!--
  Resolving a commit's conflicts, as a takeover of the workspace like the
  operation log: the conflicted files down the left, the merge editor for the
  selected one on the right. Each resolution rewrites the commit, so after
  every file the view follows the change to its new commit.
-->
<script lang="ts" module>
  export interface ResolveCallbacks {
    loadConflict(commitId: string, path: string): Promise<ConflictFile>;
    /** Writes a resolution, then calls `update` with the rewritten commit. */
    resolve(path: string, content: string): void;
    takeSide(path: string, side: "ours" | "theirs"): void;
    close(): void;
  }
</script>

<script lang="ts">
  import { storage } from "../api";
  import { CLOSE } from "../icons";
  import type { ConflictFile, MergeLayout } from "../mergeview";
  import type { LogRow } from "../types";
  import MergeEditor from "./MergeEditor.svelte";

  let { loadConflict, resolve, takeSide, close }: ResolveCallbacks = $props();

  let row = $state.raw<LogRow | null>(null);
  let conflicts = $state.raw<string[]>([]);
  let resolved = $state.raw<string[]>([]);
  let current = $state<string | null>(null);
  type Pane =
    | { state: "empty" }
    | { state: "loading" }
    | { state: "error"; message: string }
    | { state: "unsupported"; path: string }
    | { state: "editor"; path: string; file: ConflictFile; layout: MergeLayout };
  let pane = $state.raw<Pane>({ state: "empty" });
  let editor = $state<ReturnType<typeof MergeEditor>>();

  const all = $derived([...conflicts, ...resolved.filter((p) => !conflicts.includes(p))]);

  export function open(next: LogRow, files: string[], path: string) {
    resolved = [];
    update(next, files, path);
  }

  export function hide() {
    pane = { state: "empty" };
  }

  /** After a resolution: the rewritten commit and what's still conflicted. */
  export function update(next: LogRow, files: string[], target?: string, justResolved?: string) {
    if (justResolved && !resolved.includes(justResolved)) resolved = [...resolved, justResolved];
    row = next;
    conflicts = files;
    const path = target && files.includes(target) ? target : files[0];
    if (path) select(path);
  }

  export function jump(delta: 1 | -1) {
    editor?.jump(delta);
  }

  async function select(path: string) {
    const at = row!;
    current = path;
    pane = { state: "loading" };
    let file: ConflictFile;
    try {
      file = await loadConflict(at.commitId, path);
    } catch (err) {
      pane = { state: "error", message: String(err) };
      return;
    }
    if (current !== path || row !== at) return;
    if (!file.supported) {
      pane = { state: "unsupported", path };
      return;
    }
    pane = { state: "editor", path, file, layout: (storage("mergeLayout") as MergeLayout | null) ?? "columns" };
  }
</script>

<div class="takeover-card resolve-card">
  <div class="takeover-header">
    <span class="takeover-title"
      >{#if row}Resolve conflicts <span class="id change-id">{row.changeId.slice(0, 8)}</span>{" "}<span class="muted">{row.summary || "(no description set)"}</span
        >{/if}</span
    >
    <button class="header-button oplog-close" data-action="close" title="Close (Esc)" onclick={close}>{@html CLOSE}</button>
  </div>
  <div class="resolve-body">
    <div class="resolve-files">
      {#if row}
        <div class="list-section">{conflicts.length} {conflicts.length === 1 ? "file" : "files"} to resolve</div>
        {#each all as path (path)}
          {@const done = !conflicts.includes(path)}
          {@const slash = path.lastIndexOf("/")}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class={["tree-row", "file", path === current && "selected", done && "done"]}
            data-path={path}
            title={path}
            onmousedown={() => conflicts.includes(path) && select(path)}
          >
            <span class="status {done ? 'added' : 'modified conflict'}">{done ? "✓" : "!"}</span>
            <span class="path"><span class="name">{path.slice(slash + 1)}</span>{#if slash >= 0}<span class="dir">{path.slice(0, slash + 1)}</span>{/if}</span>
          </div>
        {/each}
      {/if}
    </div>
    <div class="resolve-pane">
      {#if pane.state === "loading"}
        <div class="placeholder-text">Loading conflict…</div>
      {:else if pane.state === "error"}
        <div class="placeholder-text error-text">{pane.message}</div>
      {:else if pane.state === "unsupported"}
        {@const path = pane.path}
        <div class="placeholder-text">
          This conflict has more than two sides or isn't a text file, so it can't be merged here.
          <div class="merge-fallback">
            <button class="header-button text" data-side="ours" onclick={() => takeSide(path, "ours")}>Take All of Side 1</button><button
              class="header-button text"
              data-side="theirs"
              onclick={() => takeSide(path, "theirs")}>Take All of Side 2</button
            >
          </div>
        </div>
      {:else if pane.state === "editor"}
        {@const path = pane.path}
        {#key pane}
          <MergeEditor
            bind:this={editor}
            {path}
            file={pane.file}
            layout={pane.layout}
            resolve={(content) => resolve(path, content)}
            takeSide={(side) => takeSide(path, side)}
            cancel={close}
            layoutChanged={(next) => storage("mergeLayout", next)}
          />
        {/key}
      {/if}
    </div>
  </div>
</div>
