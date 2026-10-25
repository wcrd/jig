<!-- A change or commit ID: its unique prefix in bold, then the rest up to `length` characters. -->
<script lang="ts">
  let { id, prefix, length = 8, kind = "change-id" }: { id: string; prefix: number; length?: number; kind?: string } = $props();
</script>

<span class="id {kind}"><b>{id.slice(0, prefix)}</b>{id.slice(prefix, length)}</span>
