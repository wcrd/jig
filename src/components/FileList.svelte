<!--
  The left side's file list: the commit's changed files, as a list or a tree,
  with any unresolved conflicts first; or, on the File Tree tab, the whole
  repository at that commit.
-->
<script lang="ts">
  import { type DetailsPanel, STATUS_LETTER } from "../details.svelte";
  import { FILE_ROW_HEIGHT, type TreeLine, treeLines } from "../filetree";
  import { CHEVRON, COLLAPSE, FILE, FOLDER, LIST, TREE } from "../icons";
  import type { FileDiff, FileStatus } from "../types";

  let { panel }: { panel: DetailsPanel } = $props();

  // Copied so files replaced in place (an omitted one, loaded) redraw.
  const files = $derived.by(() => {
    void panel.filesVersion;
    return [...(panel.diff?.files ?? [])];
  });
  const conflicts = $derived(panel.compareFrom ? [] : (panel.diff?.conflicts ?? []));
  const changesLines = $derived(panel.changesView === "tree" && panel.changesTree ? treeLines(panel.changesTree, panel.changesCollapsed) : []);
  const treeLoaded = $derived(!!panel.row && panel.treeCommit === panel.row.commitId && !!panel.treeRoot);
  const repoLines = $derived(treeLoaded ? treeLines(panel.treeRoot!, panel.treeCollapsed()) : []);
  const treeChanged = $derived(new Map(files.map((f) => [f.path, f])));

  // The rows below any conflicts, which can run to thousands: only those in
  // view are drawn, in a block as tall as all of them.
  type ListLine = { item: number; name: string; dir: string };
  const lines: (TreeLine | ListLine)[] = $derived.by(() => {
    if (panel.tab === "tree") return repoLines;
    if (!panel.diff) return [];
    if (panel.changesView === "tree") return changesLines;
    return files.map((file, item) => {
      const [name, dir] = splitPath(file.path);
      return { item, name, dir };
    });
  });
  const OVERSCAN = 10;
  let list: HTMLElement;
  let block: HTMLElement | undefined = $state();
  let scrollTop = $state(0);
  let height = $state(0);
  // Where the block starts in the list's scrolled content.
  let blockTop = $state(0);
  $effect(() => {
    void lines;
    void conflicts.length;
    blockTop = block ? block.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop : 0;
  });
  const first = $derived(Math.max(0, Math.floor((scrollTop - blockTop) / FILE_ROW_HEIGHT) - OVERSCAN));
  const last = $derived(Math.min(lines.length, Math.ceil((scrollTop - blockTop + height) / FILE_ROW_HEIGHT) + OVERSCAN));
  const shown = $derived(lines.slice(first, last));

  function splitPath(path: string): [string, string] {
    const slash = path.lastIndexOf("/");
    return [path.slice(slash + 1), slash >= 0 ? path.slice(0, slash + 1) : ""];
  }

  function folderDown(path: string) {
    panel.focusedFolder = path;
    panel.toggleFolder(path);
  }

  function fileMenu(event: MouseEvent, index: number) {
    if (panel.tab === "tree" || panel.compareFrom || !panel.diff) return;
    event.preventDefault();
    const path = panel.diff.files[index]?.path;
    if (path) panel.source.fileMenu(path);
  }

  const emptyMessage = $derived(
    conflicts.length > 0
      ? "No changes beyond its parents"
      : panel.compareFrom
        ? "The two commits have identical contents"
        : (panel.diff?.parents.length ?? 0) > 1
          ? "Clean merge: no changes beyond its parents"
          : "No changes",
  );
  const selectedFile = (index: number) => panel.focusedFolder === null && index === (panel.tab === "tree" ? panel.treeIndex() : panel.fileIndex);
</script>

{#snippet badge(status: FileStatus, conflict: boolean)}
  <span class="status {status}{conflict ? ' conflict' : ''}">{conflict ? "!" : STATUS_LETTER[status]}</span>
{/snippet}

{#snippet changedFile(file: FileDiff, index: number, name: string, dir: string)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  {#if panel.split}<span
      class="check {{ none: '', some: 'some', all: 'on' }[panel.fileSplitState(file)]}"
      data-check={index}
      title="Include in the first commit"
      onmousedown={(event) => {
        event.stopPropagation();
        panel.toggleSplitFile(index);
      }}
    ></span>{/if}{@render badge(file.status, file.conflict)}<span class="path" title={file.sourcePath ? `${file.sourcePath} → ${file.path}` : file.path}
    ><span class="name">{name}</span>{#if dir}<span class="dir">{dir}</span>{/if}</span
  ><span class="stats"
    >{#if file.binary}<span class="muted">bin</span>{:else if !file.omitted}<span class="add">+{file.additions}</span> <span class="del">−{file.deletions}</span>{/if}</span
  >
{/snippet}

{#snippet folder(path: string, name: string, depth: number, open: boolean)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class={["tree-row", "folder", open && "open", path === panel.focusedFolder && "selected"]} data-folder={path} style="padding-left:{10 + depth * 14}px" onmousedown={() => folderDown(path)}>
    {@html CHEVRON}{@html FOLDER}<span class="name">{name}</span>
  </div>
{/snippet}

<div data-ref="file-header" class="file-header">
  {#if panel.tab === "tree"}
    {#if treeLoaded}
      <span>{panel.treeEntries.length.toLocaleString()} files</span><span class="header-buttons"
        ><button class="header-button" data-action="collapse" title="Collapse all folders" onclick={() => panel.collapseTree()}>{@html COLLAPSE}</button></span
      >
    {:else}
      <span>Files</span>
    {/if}
  {:else if panel.diff}
    {@const additions = files.reduce((n, f) => n + f.additions, 0)}
    {@const deletions = files.reduce((n, f) => n + f.deletions, 0)}
    <span>{files.length} {files.length === 1 ? "file" : "files"} changed</span>{#if files.length}<span class="stats"
        ><span class="add">+{additions}</span> <span class="del">−{deletions}</span></span
      >{/if}<span class="header-buttons"
      ><button class={["header-button", panel.changesView === "list" && "active"]} data-action="list" title="Show as list" onclick={() => panel.setChangesView("list")}
        >{@html LIST}</button
      ><button class={["header-button", panel.changesView === "tree" && "active"]} data-action="tree" title="Show as tree" onclick={() => panel.setChangesView("tree")}
        >{@html TREE}</button
      ></span
    >
  {:else if panel.row}
    <span>Changes</span>
  {/if}
</div>
<div data-ref="file-list" class="file-list" bind:this={list} bind:clientHeight={height} onscroll={() => (scrollTop = list.scrollTop)}>
  {#if panel.tab === "tree"}
    {#if !treeLoaded && panel.row && panel.treeLoad?.state === "error"}
      <div class="placeholder-text error-text">{panel.treeLoad.message}</div>
    {:else if !treeLoaded && panel.row}
      <div class="placeholder-text">Loading…</div>
    {/if}
  {:else if panel.diff}
    {#if conflicts.length > 0}
      <div class="list-section conflicts">Unresolved conflicts</div>
      {#each conflicts as path (path)}
        {@const [name, dir] = splitPath(path)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class={["tree-row", "file", panel.focusedFolder === null && path === panel.conflictPath && "selected"]}
          data-conflict={path}
          title={path}
          onmousedown={() => panel.showConflict(path)}
        >
          <span class="status modified conflict">!</span><span class="path"><span class="name">{name}</span>{#if dir}<span class="dir">{dir}</span>{/if}</span>
        </div>
      {/each}
    {/if}
    {#if files.length === 0}
      <!-- jj diffs a merge against its auto-merged parents, so a clean merge has no changes of its own. -->
      <div class="placeholder-text">{emptyMessage}</div>
    {:else if conflicts.length > 0}
      <div class="list-section">Changes</div>
    {/if}
  {/if}
  {#if lines.length > 0}
    <div class="file-rows" bind:this={block} style="height:{lines.length * FILE_ROW_HEIGHT}px">
      <div style="transform:translateY({first * FILE_ROW_HEIGHT}px)">
        {#each shown as line ("folder" in line ? `d${line.folder}` : `f${line.item}`)}
          {#if "folder" in line}
            {@render folder(line.folder, line.name, line.depth, line.open)}
          {:else if panel.tab === "tree" && "depth" in line}
            {@const file = treeChanged.get(panel.treeEntries[line.item].path)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class={["tree-row", "file", selectedFile(line.item) && "selected"]}
              data-index={line.item}
              style="padding-left:{10 + line.depth * 14}px"
              onmousedown={() => panel.selectItem(line.item)}
            >
              <span class="chevron-space"></span>{#if file}{@render badge(file.status, file.conflict)}{:else}{@html FILE}{/if}<span class="path"
                ><span class="name">{line.name}</span></span
              >
            </div>
          {:else if "depth" in line}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class={["tree-row", "file", selectedFile(line.item) && "selected"]}
              data-index={line.item}
              style="padding-left:{10 + line.depth * 14}px"
              onmousedown={() => panel.selectItem(line.item)}
              oncontextmenu={(event) => fileMenu(event, line.item)}
            >
              <span class="chevron-space"></span>{@render changedFile(files[line.item], line.item, line.name, "")}
            </div>
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class={["tree-row", "file", selectedFile(line.item) && "selected"]}
              data-index={line.item}
              onmousedown={() => panel.selectItem(line.item)}
              oncontextmenu={(event) => fileMenu(event, line.item)}
            >
              {@render changedFile(files[line.item], line.item, line.name, line.dir)}
            </div>
          {/if}
        {/each}
      </div>
    </div>
  {/if}
</div>
