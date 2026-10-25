<!--
  The bar for a multi-step operation in progress, jjui-style: what it will
  do, its options, and Enter to run it or Esc to cancel.
-->
<script lang="ts">
  import { MODE_LABELS, PLACEMENT_LABELS, type Placement, type RebaseMode, type Repo } from "../repo.svelte";

  let { repo }: { repo: Repo } = $props();

  // The operation changes in place, so this takes a fresh copy of it, and
  // what's worked out from it, each time Repo says it changed.
  const mode = $derived.by(() => {
    void repo.modeVersion;
    const p = repo.pending;
    if (!p || !repo.log) return null;
    return {
      p: { ...p },
      rows: repo.log.rows,
      problem: repo.pendingProblem(),
      moving: p.kind === "rebase" ? repo.movingRows().size : 0,
      split: p.kind === "split" ? repo.details.splitCounts() : null,
    };
  });
</script>

{#snippet id(index: number)}<span class="id change-id">{mode!.rows[index].changeId.slice(0, 8)}</span>{/snippet}
{#snippet summary(index: number)}<span class="modebar-summary">{mode!.rows[index].summary || "(no description set)"}</span>{/snippet}
<!-- One commit with its summary, or the first of several and how many more. -->
{#snippet commits(sources: number[])}{#if sources.length === 1}{@render id(sources[0])} {@render summary(sources[0])}{:else}{@render id(sources[0])}
    <span class="muted">+{sources.length - 1}</span>{/if}{/snippet}
{#snippet modes(current: RebaseMode)}<span class="segmented"
    >{#each [["revision", "r"], ["source", "s"], ["branch", "⇧B"]] as [value, key] (value)}<button
        class={value === current ? "active" : ""}
        data-mode={value}
        title={key}
        onclick={() => repo.setMode(value as RebaseMode)}>{MODE_LABELS[value as RebaseMode]}</button
      >{/each}</span
  >{/snippet}
{#snippet placements(current: Placement)}<span class="segmented"
    >{#each [["onto", "o"], ["after", "a"], ["before", "b"]] as [value, key] (value)}<button
        class={value === current ? "active" : ""}
        data-placement={value}
        title={key}
        onclick={() => repo.setPlacement(value as Placement)}>{PLACEMENT_LABELS[value as Placement]}</button
      >{/each}</span
  >{/snippet}

<div data-ref="modebar" class="modebar {repo.lastModeKind}" hidden={!mode}>
  {#if mode}
    {@const p = mode.p}
    {#if p.kind === "rebase"}
      {@const count = mode.moving}
      <span class="modebar-title">Rebase</span>{@render modes(p.mode)}{@render id(p.sources[0])}{#if count > 1}{" "}<span class="muted">+{count - 1}</span
        >{/if}{@render placements(p.placement)}{@render id(p.target)} {@render summary(p.target)}
    {:else if p.kind === "duplicate" || p.kind === "revert"}
      <span class="modebar-title">{p.kind === "duplicate" ? "Copy" : "Revert"}</span>{@render commits(p.sources)}{@render placements(p.placement)}{@render id(p.target)}
      {@render summary(p.target)}
    {:else if p.kind === "squash"}
      <span class="modebar-title">Squash</span>{#if p.sources.length === 1}{@render id(p.sources[0])}{:else}{@render commits(p.sources)}{/if}{#if p.paths.length > 0}{" "}<span
          class="muted">({p.paths.length === 1 ? p.paths[0] : `${p.paths.length} files`})</span
        >{/if}
      <span class="muted">into</span>
      {@render id(p.target)}
      {@render summary(p.target)}
    {:else if p.kind === "split"}
      {@const { selected, total } = mode.split!}
      <span class="modebar-title">Split</span>{@render id(p.source)} {@render summary(p.source)}<span class="muted"
        >{selected} of {total} {total === 1 ? "change" : "changes"} ticked for the first commit</span
      ><button class="modebar-button" data-action="message" data-commit="first" onclick={() => repo.editSplitMessage(false)}
        >{p.message === null ? "First commit message…" : "Edit first message…"}</button
      ><button class="modebar-button" data-action="message" data-commit="second" onclick={() => repo.editSplitMessage(true)}
        >{p.secondMessage === null ? "Second commit message…" : "Edit second message…"}</button
      >
    {:else if p.kind === "parents"}
      <span class="modebar-title">Set Parents</span>{@render id(p.source)}
      {@render summary(p.source)}
      <span class="muted">onto</span>
      {#if p.marked.length > 0}{#each p.marked as index, i (index)}{#if i > 0}{" "}{/if}{@render id(index)}{/each}{:else}<span class="muted">none</span>{/if}
    {:else}
      <span class="modebar-title">Abandon</span><span>{p.marked.size} {p.marked.size === 1 ? "commit" : "commits"} marked</span>
    {/if}
    {#if mode.problem}<span class="modebar-problem">{mode.problem}</span>{/if}
    <span class="modebar-actions"
      ><span class="muted"
        >{p.kind === "rebase" || p.kind === "duplicate" || p.kind === "revert" || p.kind === "squash"
          ? "↑↓ choose · Enter · Esc"
          : p.kind === "split"
            ? "Tick files, hunks or lines · Enter · Esc"
            : p.kind === "parents"
              ? "Space mark · Enter · Esc"
              : "Space mark · s descendants · Enter · Esc"}</span
      ><button data-action="cancel" onclick={() => repo.cancelPending()}>Cancel</button><button data-action="run" class="primary" disabled={!!mode.problem} onclick={() => repo.runPending()}
        >{{ rebase: "Rebase", duplicate: "Copy", revert: "Revert", squash: "Squash", split: "Split", parents: "Set Parents", abandon: "Abandon" }[p.kind]}</button
      ></span
    >
  {/if}
</div>
