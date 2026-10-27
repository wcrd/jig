<!-- A cheat sheet of the keyboard shortcuts. -->
<script lang="ts" module>
  const HELP: [string, [string, string][]][] = [
    [
      "Commits",
      [
        ["↑ ↓  j k", "Move"],
        ["⇧J  ⇧K", "Parent / child"],
        ["@", "Working copy"],
        ["n", "New change"],
        ["e", "Edit"],
        ["↩  ⇧D", "Describe"],
        ["c", "Commit the working copy"],
        ["d", "Full-size diff (↑ ↓ move between files)"],
        ["← →", "Shrink / grow details"],
        ["Space", "Mark for rebase, squash, copy, revert, abandon"],
        ["Esc", "Clear marks"],
        ["r", "Rebase"],
        ["⇧S", "Squash"],
        ["s", "Split"],
        ["a", "Abandon"],
        ["y", "Copy (cherry-pick)"],
        ["⇧R", "Revert"],
        ["⇧A", "Absorb"],
        ["⇧B", "Set bookmark"],
        ["b", "Bookmarks menu"],
        ["⇧M", "Set parents"],
        ["⌘-click", "Compare"],
      ],
    ],
    [
      "Rebase",
      [
        ["r / s / ⇧B", "This commit / with descendants / branch"],
        ["o / a / b", "Onto / after / before"],
        ["↑ ↓  @", "Choose destination"],
        ["↩  Esc", "Rebase / cancel"],
      ],
    ],
    [
      "Copy / revert",
      [
        ["o / a / b", "Onto / after / before"],
        ["↑ ↓  @", "Choose destination"],
        ["↩  Esc", "Run / cancel"],
      ],
    ],
    [
      "Set parents",
      [
        ["↑ ↓  @", "Move"],
        ["Space", "Mark / unmark a parent"],
        ["↩  Esc", "Set / cancel"],
      ],
    ],
    [
      "Abandon",
      [
        ["Space", "Mark"],
        ["s", "Mark descendants"],
        ["↩  Esc", "Abandon / cancel"],
      ],
    ],
    [
      "Repository",
      [
        ["u  ⇧U", "Undo / redo"],
        ["o", "Operation log"],
        ["g", "Fetch / push"],
        [":", "Run a jj command (aliases too)"],
        ["⌘F", "Find in graph, or in the diff"],
        ["⇧L  ⌘L", "Revset"],
        ["⌘R", "Reload"],
        ["⌥↑ ⌥↓", "Previous / next file"],
        ["⌘T  ⌘W", "Open / close tab"],
        ["⌘N  ⇧⌘W", "New / close window"],
        ["⌘1–9", "Switch tab"],
        ["Esc", "Close toasts"],
        ["?", "This help"],
        ["⌘,", "Settings"],
      ],
    ],
  ];
</script>

<script lang="ts">
  import { onMount } from "svelte";

  let { done }: { done: (value: void) => void } = $props();
  let dialog: HTMLDialogElement;

  onMount(() => dialog.showModal());
</script>

<!-- Clicking the backdrop closes it, as Esc does. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog class="prompt help" bind:this={dialog} onclose={() => done()} onclick={(event) => event.target === dialog && dialog.close()}>
  <div class="prompt-title">Keyboard Shortcuts <span class="muted">(the same as jjui)</span></div>
  <div class="help-grid">
    {#each HELP as [title, keys] (title)}
      <div class="help-section">
        <div class="list-section">{title}</div>
        {#each keys as [key, what] (key)}
          <div class="help-row"><kbd>{key}</kbd><span>{what}</span></div>
        {/each}
      </div>
    {/each}
  </div>
  <!-- svelte-ignore a11y_autofocus -->
  <div class="prompt-buttons"><button class="primary" autofocus onclick={() => dialog.close()}>Done</button></div>
</dialog>
