<!--
  The operation log: every jj operation on the repo, newest first, with
  restoring the repo to one or reverting just one.
-->
<script lang="ts">
  import { type OpChanges, type OpEntry, fetchOpChanges, fetchOpLog, jj, storage } from "../api";
  import { formatDate, formatFullDate } from "../format";
  import { CLOSE } from "../icons";
  import { displayCommand } from "../oplog";
  import type { CommandOutput } from "../types";
  import { confirm, showMenu } from "../ui";

  let {
    path,
    act,
    showCommit,
    close,
  }: {
    path: string;
    act: (label: string, run: () => Promise<CommandOutput>) => Promise<unknown>;
    /** Jump to a commit in the graph. */
    showCommit: (commitId: string) => void;
    close: () => void;
  } = $props();

  let ops = $state.raw<OpEntry[]>([]);
  let selected = $state<string | null>(null);
  let hideSnapshots = $state(storage("opLogHideSnapshots") === "1");
  /** Loading the log failed; it shows in place of the list. */
  let listError = $state<string | null>(null);
  /** The footer appears once the log has loaded. */
  let loaded = $state(false);
  type Detail = { state: "none" } | { state: "loading" } | { state: "error"; message: string } | { state: "loaded"; op: OpEntry; changes: OpChanges };
  let detail = $state.raw<Detail>({ state: "none" });
  let detailFor: string | null = null;
  const changesCache = new Map<string, OpChanges>();

  const shown = $derived(hideSnapshots ? ops.filter((op) => !op.snapshot || op.current) : ops);
  const current = $derived(ops.find((op) => op.id === selected));

  export async function refresh() {
    try {
      ops = await fetchOpLog(path);
      listError = null;
      loaded = true;
      // Start on the newest operation so the details pane isn't empty.
      if (!selected || !ops.some((op) => op.id === selected)) selected = ops[0]?.id ?? null;
    } catch (err) {
      listError = String(err);
      return;
    }
    syncDetail();
  }

  function select(op: OpEntry) {
    selected = op.id;
    syncDetail();
  }

  function syncDetail() {
    const op = ops.find((o) => o.id === selected);
    if (op && op.id !== detailFor) loadDetail(op);
  }

  async function loadDetail(op: OpEntry) {
    detailFor = op.id;
    let changes = changesCache.get(op.id);
    if (!changes) {
      detail = { state: "loading" };
      try {
        changes = await fetchOpChanges(path, op.id);
      } catch (err) {
        if (detailFor === op.id) detail = { state: "error", message: String(err) };
        return;
      }
      changesCache.set(op.id, changes);
    }
    if (detailFor === op.id) detail = { state: "loaded", op, changes };
  }

  async function restore() {
    const op = current;
    if (!op || op.current) return;
    const ok = await confirm(
      `Restore the repository to how it was after "${op.description}"? Later operations stay in the log, so you can undo this too.`,
      "Restore Repository",
      "Restore",
    );
    if (ok) await act(`Restore to ${op.shortId}`, () => jj.opRestore(path, op.id));
    refresh();
  }

  async function revert() {
    const op = current;
    if (!op) return;
    const ok = await confirm(`Revert just the changes made by "${op.description}"?`, "Revert Operation", "Revert");
    if (ok) await act(`Revert ${op.shortId}`, () => jj.opRevert(path, op.id));
    refresh();
  }

  function menu(event: MouseEvent, op: OpEntry) {
    event.preventDefault();
    select(op);
    showMenu([
      { text: "Restore Repository to Here…", action: () => restore(), enabled: !op.current },
      { text: "Revert This Operation…", action: () => revert() },
    ]);
  }

  const KIND_LABELS = { added: "New", removed: "Abandoned", rewritten: "Rewritten" };
</script>

{#snippet short(id: string | null)}
  {#if id}<span class="id">{id.slice(0, 8)}</span>{:else}<span class="muted">—</span>{/if}
{/snippet}

{#snippet changesView(op: OpEntry, changes: OpChanges)}
  {@const command = op.args ? displayCommand(op.args) : null}
  <div class="opd-title">What changed{#if command}{" · "}<span class="op-command">{command}</span>{/if}</div>
  {#if changes.changes.length === 0 && changes.bookmarks.length === 0 && changes.workingCopies.length === 0}
    <div class="placeholder-text">No visible changes</div>
  {/if}
  {#if changes.changes.length > 0}
    <div class="opd-section">Changes</div>
    {#each changes.changes as c (c.changeId + c.commitId)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="opd-row" data-commit={c.commitId} title="Show in graph" onclick={() => showCommit(c.commitId)}>
        <span class="opd-kind {c.kind}">{KIND_LABELS[c.kind]}</span><span class="id change-id">{c.changeId.slice(0, 8)}</span><span class="opd-summary"
          >{#if c.summary}{c.summary}{:else}<span class="placeholder">(no description set)</span>{/if}{#if c.empty}{" "}<span class="muted">(empty)</span>{/if}</span
        >{#if c.oldCommitId}<span class="opd-commits">{@render short(c.oldCommitId)} → {@render short(c.commitId)}</span>{:else}<span class="opd-commits"
            >{@render short(c.commitId)}</span
          >{/if}
      </div>
    {/each}
    {#if changes.truncated}<div class="placeholder-text">…and more</div>{/if}
  {/if}
  {#if changes.bookmarks.length > 0}
    <div class="opd-section">Bookmarks</div>
    {#each changes.bookmarks as b, i (i)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="opd-row" data-commit={b.to ?? undefined} title={b.to ? "Show in graph" : undefined} onclick={() => b.to && showCommit(b.to)}>
        <span class="opd-kind bookmark">{!b.from ? "created" : !b.to ? "deleted" : "moved"}</span><span class="opd-summary">{b.remote ? `${b.name}@${b.remote}` : b.name}</span><span
          class="opd-commits">{@render short(b.from)} → {@render short(b.to)}</span
        >
      </div>
    {/each}
  {/if}
  {#if changes.workingCopies.length > 0}
    <div class="opd-section">Working copy</div>
    {#each changes.workingCopies as w, i (i)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="opd-row" data-commit={w.to ?? undefined} title={w.to ? "Show in graph" : undefined} onclick={() => w.to && showCommit(w.to)}>
        <span class="opd-kind wc">@</span><span class="opd-summary">{w.workspace}</span><span class="opd-commits">{@render short(w.from)} → {@render short(w.to)}</span>
      </div>
    {/each}
  {/if}
{/snippet}

<div class="oplog-card">
  <div class="oplog-header">
    <span class="oplog-title">Operation Log</span>
    <label class="oplog-toggle"
      ><input
        type="checkbox"
        data-ref="hide-snapshots"
        checked={hideSnapshots}
        onchange={(event) => {
          hideSnapshots = event.currentTarget.checked;
          storage("opLogHideSnapshots", hideSnapshots ? "1" : "0");
          syncDetail();
        }}
      /> Hide snapshots</label
    >
    <button class="header-button oplog-close" data-action="close" title="Close (Esc)" onclick={close}>{@html CLOSE}</button>
  </div>
  <div class="op op-columns"><span>Operation</span><span>ID</span><span>User</span><span>When</span></div>
  <div class="oplog-list">
    {#if listError !== null}
      <div class="placeholder-text error-text">{listError}</div>
    {:else}
      {#each shown as op (op.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class={["op", op.id === selected && "selected", op.snapshot && "snapshot"]}
          data-op={op.id}
          title={`${op.args ?? op.description}\n${op.description}\n${op.user} · ${formatFullDate(op.time)}\n${op.id}`}
          onmousedown={() => select(op)}
          oncontextmenu={(event) => menu(event, op)}
        >
          <span class="op-description"
            ><span class="op-line"
              >{#if op.current}<span class="op-current">current</span>{/if}{#if op.args}<span class="op-command">{displayCommand(op.args)}</span>{:else}<span
                  class="op-command plain">{op.description}</span
                >{/if}</span
            >{#if op.args}<span class="op-subtitle">{op.description}</span>{/if}</span
          >
          <span class="id">{op.shortId}</span>
          <span class="op-user">{op.user.split("@")[0]}</span>
          <span class="op-time">{formatDate(op.time)}</span>
        </div>
      {/each}
    {/if}
  </div>
  <div class="oplog-detail">
    {#if detail.state === "none"}
      <div class="placeholder-text">Select an operation to see what it changed</div>
    {:else if detail.state === "loading"}
      <div class="placeholder-text">Loading…</div>
    {:else if detail.state === "error"}
      <div class="placeholder-text error-text">{detail.message}</div>
    {:else}
      {@render changesView(detail.op, detail.changes)}
    {/if}
  </div>
  <div class="oplog-footer">
    {#if !loaded}
      <!-- Nothing until the log has loaded. -->
    {:else if current}
      <button data-action="restore" disabled={current.current} title="jj op restore: make the repo look exactly as it did after this operation" onclick={restore}
        >Restore to Here</button
      ><button data-action="revert" title="jj op revert: undo just this operation's changes" onclick={revert}>Revert</button>
    {:else}
      <span class="muted">Select an operation to restore or revert it</span>
    {/if}
  </div>
</div>
