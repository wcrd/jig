<script lang="ts">
  import { removeToast, toasts } from "../toasts.svelte";
</script>

<div class="toasts">
  {#each toasts as toast (toast.id)}
    <div class={["toast", toast.kind !== "message" && toast.kind, toast.wide && "wide"]}>
      <div class="toast-title">
        {#if toast.kind === "running"}<span class="spinner"></span>{toast.label}…{:else if toast.kind === "success"}✓ {toast.label}{:else if toast.kind === "failure"}✕ {toast.label}{:else}{toast.label}{/if}
        {#if toast.undo}
          <button class="toast-undo" onclick={() => (removeToast(toast), toast.undo?.())}>Undo</button>
        {/if}
        {#if toast.action}
          <button class="toast-undo toast-action" onclick={() => (removeToast(toast), toast.action?.run())}>{toast.action.label}</button>
        {/if}
        {#if toast.count > 1}
          <span class="toast-count">×{toast.count}</span>
        {/if}
        {#if toast.closesAfter !== null}
          <!-- A ring that drains while the toast waits to close; hovering pauses it, holding the toast open. -->
          <span class="toast-timer" title="Closes by itself; hover to keep it open"
            ><svg viewBox="0 0 16 16" width="12" height="12"
              ><circle class="toast-timer-track" cx="8" cy="8" r="6" /><circle
                class="toast-timer-left"
                cx="8"
                cy="8"
                r="6"
                style:animation-duration="{toast.closesAfter}ms"
                onanimationend={() => removeToast(toast)}
              /></svg
            ></span
          >
        {/if}
        {#if toast.kind !== "running"}
          <button class="toast-close" title="Dismiss" onclick={() => removeToast(toast)}>×</button>
        {/if}
      </div>
      {#if toast.command}<div class="toast-command">{toast.command}</div>{/if}
      {#if toast.output}<pre class="toast-output">{toast.output}</pre>{/if}
    </div>
  {/each}
</div>
