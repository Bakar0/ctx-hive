<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";

  interface Props {
    page: number;
    totalPages: number;
    total: number;
    pageSize: number;
    onPrev: () => void;
    onNext: () => void;
  }

  let { page, totalPages, total, pageSize, onPrev, onNext }: Props = $props();

  let start = $derived((page - 1) * pageSize + 1);
  let end = $derived(Math.min(page * pageSize, total));
</script>

{#if total > 0}
  <div class="flex items-center justify-center gap-3 py-4">
    <Button variant="outline" size="sm" disabled={page <= 1} onclick={onPrev}>&larr; Prev</Button>
    <span class="text-xs text-muted-foreground font-mono">{start}&ndash;{end} of {total}</span>
    <Button variant="outline" size="sm" disabled={page >= totalPages} onclick={onNext}>Next &rarr;</Button>
  </div>
{/if}
