<!-- The window: a strip of repository tabs over the selected repository's view. -->
<script lang="ts">
  import { onMount } from "svelte";

  import {
    attachTabStrip,
    cancelDrag,
    chooseRepo,
    nameHints,
    tabMenu,
    tabPointerDown,
    tabPointerMove,
    tabPointerUp,
    tabs,
  } from "../tabs.svelte";
  import RepoView from "./RepoView.svelte";
  import Toasts from "./Toasts.svelte";

  let tabStrip: HTMLElement;
  let tabList: HTMLElement;
  let dropMarker: HTMLElement;

  // For tabs that share a name, the parent folders that tell them apart.
  const hints = $derived(nameHints());

  onMount(() => attachTabStrip(tabStrip, tabList, dropMarker));

  $effect(() => {
    document.title = tabs.active ? `${tabs.active.name} — Jig` : "Jig";
  });
</script>

<nav id="repo-tabs" class="repo-tabs" bind:this={tabStrip}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    id="tab-list"
    class="tab-list"
    bind:this={tabList}
    onpointerdown={tabPointerDown}
    onpointermove={tabPointerMove}
    onpointerup={tabPointerUp}
    onpointercancel={cancelDrag}
    oncontextmenu={tabMenu}
    onlostpointercapture={cancelDrag}
  >
    {#each tabs.views as view, i (view)}
      {@const dragged = tabs.dragged === view}
      <div class={["tab", view === tabs.active && "active", dragged && "dragging", dragged && tabs.leaving && "leaving"]} data-index={i} title={view.path}>
        <span class="tab-name">{view.name}{#if hints.get(view)}{" "}<span class="tab-hint">{hints.get(view)}</span>{/if}</span>
        <button class="tab-close" data-close={i} title="Close tab (⌘W)">
          <svg viewBox="0 0 10 10" width="8" height="8"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
        </button>
      </div>
    {/each}
  </div>
  <!-- Where a tab dragged from another window would land; tabs.svelte.ts places it. -->
  <div id="drop-marker" class="drop-marker" bind:this={dropMarker} hidden></div>
  <button id="new-tab" class="new-tab" title="Open repository in a new tab (⌘T)" onclick={chooseRepo}>
    <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
  </button>
</nav>
<div id="views" class="views">
  {#each tabs.opened as view (view)}
    <RepoView repo={view} active={view === tabs.active} />
  {/each}
</div>
<div id="empty" class="empty" hidden={tabs.views.length > 0}>
  <p>Open a jj repository to see its graph.</p>
  <button id="empty-open" onclick={chooseRepo}>Open Repository…</button>
</div>
<Toasts />
