<!-- A small find bar (⌘F) that floats over the area being searched. -->
<script lang="ts">
  import { onMount } from "svelte";

  import type { SearchTarget } from "../search.svelte";

  let {
    target,
    query = $bindable(""),
    close,
  }: {
    target: SearchTarget;
    /** Kept by the owner, so it's still there the next time the bar opens. */
    query?: string;
    close: () => void;
  } = $props();

  let input: HTMLInputElement;
  let total = $state(0);
  let count = $state("");

  export function focus() {
    input.focus();
    input.select();
  }

  onMount(() => {
    focus();
    if (query) apply();
  });

  function apply() {
    total = query ? target.setQuery(query) : 0;
    if (!query) target.clear();
    count = query ? (total ? `${total} found` : "No matches") : "";
    if (total) step(1);
  }

  function step(delta: 1 | -1) {
    if (!total) return;
    count = `${target.step(delta)} of ${total}`;
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }
</script>

<div class={["search-bar", query && total === 0 && "none"]}>
  <svg viewBox="0 0 16 16" width="12" height="12"
    ><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg
  >
  <input spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" placeholder="Find" bind:this={input} bind:value={query} oninput={apply} onkeydown={keydown} />
  <span class="search-count">{count}</span>
  <button data-step="-1" title="Previous (⇧↩)" onclick={() => step(-1)}>↑</button>
  <button data-step="1" title="Next (↩)" onclick={() => step(1)}>↓</button>
  <button data-close title="Close (Esc)" onclick={close}>×</button>
</div>
