<!--
  A three-way merge editor for resolving a conflicted file: the two sides
  with the result between them (or stacked), block by block. Clean regions
  are already merged; each conflict block takes a side with » / «, both in
  either order, the base, or hand-edited text.
-->
<script lang="ts">
  import { tick, untrack } from "svelte";

  import { type ConflictFile, type ConflictHunk, type MergeCallbacks, type MergeLayout, display, joinBlocks, lineCount } from "../mergeview";
  import { type MenuEntry, showMenu } from "../ui";

  let {
    path,
    file,
    layout: initialLayout,
    resolve,
    takeSide,
    cancel,
    layoutChanged,
  }: { path: string; file: ConflictFile; layout: MergeLayout } & MergeCallbacks = $props();

  /** Long clean regions are folded to this many lines at each end. */
  const FOLD_CONTEXT = 3;

  // svelte-ignore state_referenced_locally
  let layout = $state(initialLayout);
  /** For each conflict hunk, the chosen result text, or null while unresolved. */
  // svelte-ignore state_referenced_locally
  let choices = $state<(string | null)[]>(file.hunks.map(() => null));
  let unfolded = $state(new Set<number>());
  /** Bumped to draw the blocks afresh, as switching layout or unfolding does. */
  let generation = $state(0);
  let root: HTMLElement;
  let body: HTMLElement;
  const textareas: HTMLTextAreaElement[] = [];

  const total = $derived(file.hunks.filter((h) => h.kind === "conflict").length);
  const left = $derived(file.hunks.filter((h, i) => h.kind === "conflict" && choices[i] === null).length);
  const result = $derived(file.hunks.map((h, i) => (h.kind === "resolved" ? h.text : (choices[i] ?? ""))).join(""));
  // jj refuses to resolve a file to nothing, so an empty result can't be saved.
  const empty = $derived(left === 0 && result === "");

  /** Moves to the next or previous unresolved conflict (n / p). */
  export function jump(delta: 1 | -1) {
    const blocks = [...root.querySelectorAll<HTMLElement>(".mblock.conflict")];
    if (blocks.length === 0) return;
    const top = body.scrollTop;
    const ordered = delta > 0 ? blocks : [...blocks].reverse();
    const next =
      ordered.find((b) => (delta > 0 ? b.offsetTop > top + 4 : b.offsetTop < top - 4) && b.classList.contains("unresolved")) ??
      ordered.find((b) => b.classList.contains("unresolved")) ??
      ordered[0];
    body.scrollTop = next.offsetTop - 12;
  }

  function choose(index: number, text: string | null) {
    choices[index] = text;
    const textarea = textareas[index];
    if (textarea) {
      textarea.value = text === null ? "" : display(text);
      textarea.rows = Math.max(1, lineCount(text ?? ""));
    }
  }

  function typed(index: number, textarea: HTMLTextAreaElement) {
    // Typed text is kept as written; the file's own line ending follows it.
    const value = textarea.value;
    choices[index] = value === "" ? "" : value.endsWith("\n") ? value : `${value}\n`;
    textarea.rows = Math.max(1, lineCount(value));
  }

  /** Fills a block's text box when it's drawn; after that, typing and choosing change it. */
  function result_box(index: number, hunk: Extract<ConflictHunk, { kind: "conflict" }>) {
    return (textarea: HTMLTextAreaElement) => {
      const choice = untrack(() => choices[index]);
      const [leftText = "", rightText = ""] = hunk.sides;
      textarea.value = display(choice ?? "");
      textarea.rows = Math.max(1, lineCount(choice ?? ""), lineCount(leftText), lineCount(rightText));
      textareas[index] = textarea;
    };
  }

  function switchLayout() {
    layout = layout === "columns" ? "stacked" : "columns";
    layoutChanged(layout);
    generation++;
  }

  async function unfold(index: number) {
    const top = body.scrollTop;
    unfolded.add(index);
    unfolded = new Set(unfolded);
    generation++;
    await tick();
    body.scrollTop = top;
  }

  function more(index: number, hunk: Extract<ConflictHunk, { kind: "conflict" }>) {
    const [l = "", r = ""] = hunk.sides;
    const entries: MenuEntry[] = [
      { text: "Take Left", action: () => choose(index, l) },
      { text: "Take Right", action: () => choose(index, r) },
      { text: "Both, Left First", action: () => choose(index, joinBlocks(l, r)) },
      { text: "Both, Right First", action: () => choose(index, joinBlocks(r, l)) },
      { text: `Take ${file.baseLabel}`, action: () => choose(index, hunk.base[0] ?? "") },
      "separator",
      { text: "Clear", action: () => choose(index, null) },
    ];
    showMenu(entries);
  }

  function keydown(event: KeyboardEvent) {
    if ((event.target as HTMLElement).tagName === "TEXTAREA") return;
    if (event.key === "n" || event.key === "p") {
      event.preventDefault();
      event.stopPropagation();
      jump(event.key === "n" ? 1 : -1);
    }
  }
</script>

{#snippet side(text: string)}
  <pre>{#if display(text)}{display(text)}{:else}<span class="muted">(nothing)</span>{/if}</pre>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="merge {layout}" bind:this={root} onkeydown={keydown}>
  <div class="merge-header">
    <span class="status modified conflict">!</span><span class="diff-path">{path}</span>
    <span class="merge-count">{left === 0 ? `All ${total} ${total === 1 ? "conflict" : "conflicts"} resolved` : `${left} of ${total} ${total === 1 ? "conflict" : "conflicts"} left`}</span>
    <span class="header-buttons">
      <button class="header-button" data-action="prev" title="Previous conflict (p)" onclick={() => jump(-1)}>↑</button>
      <button class="header-button" data-action="next" title="Next conflict (n)" onclick={() => jump(1)}>↓</button>
      <button class="header-button text" data-action="layout" title="Switch between side-by-side and stacked" onclick={switchLayout}
        >{layout === "columns" ? "Stacked" : "Side by Side"}</button
      >
      <button
        class="header-button text"
        data-action="more"
        title="Take a whole side"
        onclick={() =>
          showMenu([
            { text: `Take All of “${file.labels[0] ?? "Side 1"}”`, action: () => takeSide("ours") },
            { text: `Take All of “${file.labels[1] ?? "Side 2"}”`, action: () => takeSide("theirs") },
          ])}>Take All…</button
      >
      <button class="header-button text" data-action="cancel" onclick={cancel}>Cancel</button>
      <button
        class="header-button text primary"
        data-action="resolve"
        disabled={left > 0 || empty}
        title={empty ? "jj can't resolve a file to empty content" : ""}
        onclick={() => left === 0 && resolve(result)}>Mark Resolved</button
      >
    </span>
  </div>
  <div class="merge-labels">
    <span class="mlabel left" title={file.labels[0] ?? ""}>{file.labels[0] ?? "Side 1"}</span><span class="mlabel result">Result</span><span
      class="mlabel right"
      title={file.labels[1] ?? ""}>{file.labels[1] ?? "Side 2"}</span
    >
  </div>
  <div class="merge-body" bind:this={body}>
    {#key generation}
      {#each file.hunks as hunk, index (index)}
        {#if hunk.kind === "resolved"}
          {@const lines = display(hunk.text).split("\n")}
          <div class="mblock resolved">
            {#each ["left", "result", "right"] as cls (cls)}
              {#if lines.length > FOLD_CONTEXT * 2 + 2 && !unfolded.has(index)}
                <div class="mcell {cls}">
                  <pre>{lines.slice(0, FOLD_CONTEXT).join("\n")}</pre><button class="mfold" data-unfold={index} onclick={() => unfold(index)}
                    >⋯ {lines.length - FOLD_CONTEXT * 2} unchanged lines</button
                  ><pre>{lines.slice(-FOLD_CONTEXT).join("\n")}</pre>
                </div>
              {:else}
                <div class="mcell {cls}"><pre>{display(hunk.text)}</pre></div>
              {/if}
            {/each}
          </div>
        {:else}
          <div class={["mblock", "conflict", choices[index] === null && "unresolved"]} data-hunk={index}>
            <div class="mcell left">
              <button class="mtake" data-take="left" title="Use this side" onclick={() => choose(index, hunk.sides[0] ?? "")}>»</button>{@render side(hunk.sides[0] ?? "")}
            </div>
            <div class="mcell result">
              <div class="mresult-tools"><button class="mmenu" data-menu={index} title="More choices" onclick={() => more(index, hunk)}>⋯</button></div>
              <textarea
                spellcheck="false"
                autocapitalize="off"
                {...{ autocorrect: "off" }}
                placeholder="Take a side with » or «, or type the result"
                {@attach result_box(index, hunk)}
                oninput={(event) => typed(index, event.currentTarget)}
              ></textarea>
            </div>
            <div class="mcell right">
              <button class="mtake" data-take="right" title="Use this side" onclick={() => choose(index, hunk.sides[1] ?? "")}>«</button>{@render side(hunk.sides[1] ?? "")}
            </div>
          </div>
        {/if}
      {/each}
    {/key}
  </div>
</div>
