<!-- Settings: the theme, graph dates and colours, and how long toasts stay. -->
<script lang="ts">
  import { onMount } from "svelte";

  import { storage } from "../api";
  import {
    GRAPH_DATES,
    PALETTES,
    THEMES,
    TOAST_SECONDS,
    applyPalette,
    applyTheme,
    graphDate,
    palette,
    savedTheme,
    setGraphDate,
    setToastSeconds,
    toastSeconds,
  } from "../settings";

  let { done }: { done: (value: void) => void } = $props();
  let dialog: HTMLDialogElement;

  let theme = $state(savedTheme());
  let date = $state(graphDate());
  let seconds = $state(toastSeconds());
  const current = palette(storage("palette")).id;

  onMount(() => dialog.showModal());
</script>

{#snippet swatches(colors: string[], cls: string)}
  <span class="swatches {cls}">{#each colors as color, i (i)}<span style="background:{color}"></span>{/each}</span>
{/snippet}

<!-- Clicking the backdrop closes it, as Esc does. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog class="prompt settings" bind:this={dialog} onclose={() => done()} onclick={(event) => event.target === dialog && dialog.close()}>
  <div class="prompt-title">Settings</div>
  <div class="list-section">Theme</div>
  <div class="theme-options">
    {#each THEMES as [id, name] (id)}
      <button data-theme-choice={id} class={{ on: id === theme }} onclick={() => applyTheme((theme = id))}>{name}</button>
    {/each}
  </div>
  <div class="list-section">Graph dates</div>
  <div class="theme-options graph-date-options">
    {#each GRAPH_DATES as [id, name] (id)}
      <button data-graph-date={id} class={{ on: id === date }} onclick={() => setGraphDate((date = id))}>{name}</button>
    {/each}
  </div>
  <div class="list-section">Toasts stay for</div>
  <div class="theme-options toast-time-options">
    {#each TOAST_SECONDS as s (s)}
      <button data-toast-seconds={s} class={{ on: s === seconds }} onclick={() => setToastSeconds((seconds = s))}>{s} s</button>
    {/each}
  </div>
  <div class="list-section">Graph colours</div>
  <div class="palette-options">
    {#each PALETTES as p (p.id)}
      <label class="palette-option"
        ><input type="radio" name="palette" value={p.id} checked={p.id === current} onchange={() => applyPalette(p.id)} /><span class="palette-text"
          ><span class="palette-name">{p.name}</span><span class="palette-description">{p.description}</span></span
        >{@render swatches(p.light, "light")}{@render swatches(p.dark, "dark")}</label
      >
    {/each}
  </div>
  <div class="prompt-buttons">
    <span class="settings-version">Jig {__APP_VERSION__}{__APP_COMMIT__ ? ` (${__APP_COMMIT__})` : ""}</span>
    <!-- svelte-ignore a11y_autofocus -->
    <button class="primary" autofocus onclick={() => dialog.close()}>Done</button>
  </div>
</dialog>
