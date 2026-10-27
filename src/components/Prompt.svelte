<!--
  Asks for a line of text in a small modal; `done` gets null if cancelled.
  With `history` (oldest first), ↑ / ↓ step through earlier entries.
-->
<script lang="ts">
  import { onMount } from "svelte";

  let {
    title,
    label,
    initial = "",
    placeholder = "",
    history = [],
    done,
  }: {
    title: string;
    label: string;
    initial?: string;
    placeholder?: string;
    history?: string[];
    done: (value: string | null) => void;
  } = $props();

  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  // Where ↑ / ↓ are in `history`; its length is the line being typed.
  // svelte-ignore state_referenced_locally
  let place = history.length;
  // svelte-ignore state_referenced_locally
  let typed = initial;

  onMount(() => {
    input.value = initial;
    dialog.showModal();
    input.select();
  });

  function keydown(event: KeyboardEvent) {
    // Enter would otherwise submit with the form's first button, Cancel.
    if (event.key === "Enter") {
      event.preventDefault();
      dialog.close("ok");
    } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && history.length > 0) {
      event.preventDefault();
      if (place === history.length) typed = input.value;
      place = Math.max(0, Math.min(history.length, place + (event.key === "ArrowUp" ? -1 : 1)));
      input.value = place === history.length ? typed : history[place];
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function closed() {
    const value = dialog.returnValue === "ok" ? input.value.trim() : "";
    done(value || null);
  }
</script>

<dialog class="prompt" bind:this={dialog} onclose={closed}>
  <form method="dialog">
    <div class="prompt-title">{title}</div>
    <label>{label}<input name="value" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" {placeholder} bind:this={input} onkeydown={keydown} /></label>
    <div class="prompt-buttons"><button value="cancel" formnovalidate>Cancel</button><button value="ok" class="primary">OK</button></div>
  </form>
</dialog>
