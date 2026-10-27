<!--
  The commit on the Commit tab: its message (or the editor, while editing
  it), author and co-authors, IDs, dates and parents. In compare mode, both
  ends of the comparison.
-->
<script lang="ts">
  import { agentBadge, avatarHtml } from "../agents";
  import type { DetailsPanel, MessageEditor } from "../details.svelte";
  import { formatFullDate, reflowMessage } from "../format";
  import type { LogRow } from "../types";
  import ShortId from "./ShortId.svelte";
  import Summary from "./Summary.svelte";

  let { panel }: { panel: DetailsPanel } = $props();

  /** Fills the editor when it's drawn and hands it to the panel. */
  function attachEditor(editor: MessageEditor) {
    return (el: HTMLElement) => {
      const textarea = el.querySelector("textarea")!;
      textarea.value = editor.initial;
      editor.el = el;
      editor.textarea = textarea;
    };
  }

  // Save with ⌘↩, or jjui's ⌥↩ / ⌃S; ⌃X clears, as in jjui.
  function editorKey(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    const save =
      (event.key === "Enter" && (event.metaKey || event.ctrlKey || event.altKey)) ||
      (event.ctrlKey && event.key.toLowerCase() === "s");
    if (save || event.key === "Escape") {
      event.preventDefault();
      // Keep the key from also reaching the graph once the editor closes.
      event.stopPropagation();
      panel.finishEdit(save ? event.currentTarget.value : null);
    } else if (event.ctrlKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      event.currentTarget.value = "";
    }
  }
</script>

{#snippet side(row: LogRow, label: string)}
  <div class="cmp-side"><span class="cmp-label">{label}</span><ShortId id={row.changeId} prefix={row.changePrefixLen} /><span class="cmp-summary"><Summary text={row.summary} /></span></div>
{/snippet}

{#if panel.row && panel.compareFrom}
  <div class="ci-summary">Comparing two commits</div>
  <div class="cmp">{@render side(panel.compareFrom, "From")}{@render side(panel.row, "To")}</div>
  <div class="muted cmp-hint">⌘-click another commit to change the comparison · Esc to stop comparing</div>
{:else if panel.row}
  {@const row = panel.row}
  {@const diff = panel.diff}
  {@const [summary, ...rest] = (diff?.description ?? row.summary).split("\n")}
  {@const body = rest.join("\n").trim()}
  {@const author = diff?.author ?? { name: row.authorName, email: row.authorEmail, timestamp: row.authorTimestamp ?? row.timestamp }}
  {@const committer = diff?.committer}
  {#if panel.editor}
    {@const editor = panel.editor}
    <div class="ci-editor" {@attach attachEditor(editor)}>
      <!-- Safari's autocorrect isn't in the typings for textarea. -->
      <textarea spellcheck="true" autocapitalize="off" {...{ autocorrect: "off" }} rows="8" onkeydown={editorKey}></textarea>
      <div class="prompt-buttons">
        <span class="muted prompt-hint">⌥↩ or ⌘↩ to save · Esc to cancel</span><button data-edit="cancel" onclick={() => panel.finishEdit(null)}>Cancel</button><button
          data-edit="save"
          class="primary"
          onclick={() => panel.finishEdit(editor.textarea?.value ?? null)}>Save</button
        >
      </div>
    </div>
  {:else}
    <div class="ci-message">
      {#if summary}<div class="ci-summary">{summary}</div>{:else}<div class="ci-summary placeholder">(no description set)</div>{/if}
      {#if body}<div class="ci-body">{reflowMessage(body)}</div>{/if}
    </div>
  {/if}
  <div class="ci-person">
    {@html avatarHtml(author.name, author.email, "large")}
    <div><div><b>{author.name}</b>{@html agentBadge(author.name, author.email)} <span class="muted">&lt;{author.email}&gt;</span></div></div>
  </div>
  {#each row.coauthors as co, i (i)}
    <div class="ci-person coauthor">
      {@html avatarHtml(co.name, co.email, "medium")}
      <div>
        <b>{co.name}</b>{@html agentBadge(co.name, co.email)}{#if co.email}{" "}<span class="muted">&lt;{co.email}&gt;</span>{/if}
        <span class="muted">· co-author</span>
      </div>
    </div>
  {/each}
  <dl class="ci-meta">
    {#if committer && (committer.email !== author.email || committer.name !== author.name)}
      <dt>Committer</dt>
      <dd>{committer.name} <span class="muted">&lt;{committer.email}&gt;</span></dd>
    {/if}
    <!-- Author time is kept through rewrites, so it's roughly when the change began. -->
    <dt>Created</dt>
    <dd>{formatFullDate(author.timestamp)}</dd>
    <dt>Last changed</dt>
    <dd>{formatFullDate(committer?.timestamp ?? row.timestamp)}</dd>
    <dt>Change</dt>
    <dd class="mono"><ShortId id={row.changeId} prefix={row.changePrefixLen} length={row.changeId.length} /></dd>
    <dt>Commit</dt>
    <dd class="mono"><ShortId id={row.commitId} prefix={row.commitPrefixLen} length={row.commitId.length} kind="commit-id" /></dd>
    {#if diff && diff.parents.length > 0}
      <dt>{diff.parents.length > 1 ? "Parents" : "Parent"}</dt>
      <dd>
        {#each diff.parents as parent (parent.changeId)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="ci-parent" data-change={parent.changeId} title="Select {parent.changeId.slice(0, 8)}" onclick={() => panel.source.selectChange(parent.changeId)}>
            <span class="id change-id">{parent.changeId.slice(0, 8)}</span>
            <span class="ci-parent-summary"><Summary text={parent.summary} /></span>
          </div>
        {/each}
      </dd>
    {/if}
  </dl>
{:else if panel.message}
  <div class="placeholder-text">{panel.message}</div>
{/if}
