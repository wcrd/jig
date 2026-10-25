<!-- A commit's summary line, or a placeholder when it has none. -->
<script lang="ts">
  let { text }: { text: string } = $props();
</script>

{#if text}{text}{:else}<span class="placeholder">(no description set)</span>{/if}
