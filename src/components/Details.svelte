<!--
  The panel under the graph: tabs for the Commit, its Changes and the File
  Tree, then the commit and its files on the left and the diff or file on
  the right. The right side is drawn by DetailsPanel itself.
-->
<script lang="ts">
  import type { DetailsPanel, DetailsTab } from "../details.svelte";
  import CommitInfo from "./CommitInfo.svelte";
  import FileList from "./FileList.svelte";
  import ShortId from "./ShortId.svelte";
  import Summary from "./Summary.svelte";

  let { panel }: { panel: DetailsPanel } = $props();

  const TABS: [DetailsTab, string][] = [
    ["commit", "Commit"],
    ["changes", "Changes"],
    ["tree", "File Tree"],
  ];
</script>

<nav data-ref="detail-tabs" class="detail-tabs">
  {#each TABS as [id, label] (id)}
    <button data-tab={id} class={{ active: panel.tab === id }} onclick={() => panel.setTab(id)}>{label}</button>
  {/each}
  <button data-ref="full-diff-enter" class="full-diff-enter" title="Show the changes full size (d)">
    <svg viewBox="0 0 16 16" width="13" height="13"
      ><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg
    >
  </button>
  <button data-ref="full-diff-exit" class="full-diff-exit" title="Back to the graph (d or Esc)">Exit full size <kbd>Esc</kbd></button>
  <!-- What the panel is about: the commit, or both ends of a comparison. -->
  <div class="tab-context">
    {#if panel.row && panel.compareFrom}
      {@const from = panel.compareFrom}
      {@const to = panel.row}
      <span class="ctx-compare" title="{from.summary}  →  {to.summary}"
        ><ShortId id={from.changeId} prefix={from.changePrefixLen} /> <span class="ctx-summary"><Summary text={from.summary} /></span><span class="ctx-arrow">→</span><ShortId
          id={to.changeId}
          prefix={to.changePrefixLen}
        /> <span class="ctx-summary"><Summary text={to.summary} /></span></span
      ><button class="header-button" data-action="swap" title="Swap direction" onclick={() => panel.source.swapCompare()}>⇄</button>
    {:else if panel.row}
      {@const row = panel.row}
      <ShortId id={row.changeId} prefix={row.changePrefixLen} /> <span class="ctx-summary" title={row.summary}><Summary text={row.summary} /></span>
    {/if}
  </div>
</nav>
<div data-ref="details-body" class={["details-body", panel.tab === "commit" && "commit-mode"]}>
  <div data-ref="info-pane" class="info-pane">
    <div data-ref="commit-info" class="commit-info" hidden={panel.tab !== "commit"}><CommitInfo {panel} /></div>
    <FileList {panel} />
  </div>
  <div data-ref="split-info" class="splitter columns" title="Drag to resize"></div>
  <div data-ref="diff-view" class="diff-view"></div>
</div>
