<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";

  interface Props {
    page?: number;
    currentPage?: number;
    totalPages: number;
    total?: number;
    pageSize?: number;
    onPrev?: () => void;
    onNext?: () => void;
    onPageChange?: (page: number) => void;
  }

  let { page: pageProp, currentPage, totalPages, total, pageSize = 25, onPrev, onNext, onPageChange }: Props = $props();

  let page = $derived(pageProp ?? currentPage ?? 1);
  let start = $derived(total != null ? (page - 1) * pageSize + 1 : 0);
  let end = $derived(total != null ? Math.min(page * pageSize, total) : 0);
</script>

{#if totalPages > 1}
  <div class="flex items-center justify-center gap-3 py-4">
    <Button variant="outline" size="sm" disabled={page <= 1} onclick={() => { onPrev?.(); onPageChange?.(page - 1); }}>&larr; Prev</Button>
    {#if total != null}
      <span class="text-xs text-muted-foreground font-mono">{start}&ndash;{end} of {total}</span>
    {:else}
      <span class="text-xs text-muted-foreground font-mono">{page} / {totalPages}</span>
    {/if}
    <Button variant="outline" size="sm" disabled={page >= totalPages} onclick={() => { onNext?.(); onPageChange?.(page + 1); }}>Next &rarr;</Button>
  </div>
{/if}
