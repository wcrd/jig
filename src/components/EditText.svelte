<!-- Edits multi-line text (a commit message); `done` gets null if cancelled. -->
<script lang="ts">
  import { onMount } from "svelte";

  let { title, initial, hint = "", done }: { title: string; initial: string; hint?: string; done: (value: string | null) => void } = $props();

  let dialog: HTMLDialogElement;
  let textarea: HTMLTextAreaElement;

  onMount(() => {
    textarea.value = initial;
    dialog.showModal();
    textarea.focus();
    textarea.setSelectionRange(0, 0);
  });

  // Save with ⌘↩, or jjui's ⌥↩ / ⌃S; ⌃X clears, as in jjui.
  function keydown(event: KeyboardEvent) {
    const save =
      (event.key === "Enter" && (event.metaKey || event.ctrlKey || event.altKey)) ||
      (event.ctrlKey && event.key.toLowerCase() === "s");
    if (save) {
      event.preventDefault();
      dialog.close("ok");
    } else if (event.ctrlKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      textarea.value = "";
    }
  }
</script>

<dialog class="prompt editor" bind:this={dialog} onclose={() => done(dialog.returnValue === "ok" ? textarea.value : null)}>
  <form method="dialog">
    <div class="prompt-title">{title}</div>
    <!-- Safari's autocorrect isn't in the typings for textarea. -->
    <textarea name="value" spellcheck="true" autocapitalize="off" {...{ autocorrect: "off" }} rows="10" bind:this={textarea} onkeydown={keydown}></textarea>
    <div class="prompt-buttons"><span class="muted prompt-hint">{hint}</span><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">Save</button></div>
  </form>
</dialog>
