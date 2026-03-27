<script lang="ts">
  interface BarItem {
    label: string;
    value: number;
    color?: string;
  }

  interface Props {
    items?: BarItem[];
    data?: BarItem[];
    height?: number;
  }

  let { items: itemsProp, data, height }: Props = $props();
  let items = $derived(itemsProp ?? data ?? []);

  let max = $derived(Math.max(...items.map((i) => i.value), 1));
</script>

{#if items.length === 0}
  <div class="text-center py-12 text-muted-foreground"><p>No data</p></div>
{:else}
  <div class="flex items-end gap-1.5 h-40 pt-2">
    {#each items as item}
      <div class="flex-1 flex flex-col items-center gap-1">
        <div class="text-[10px] text-muted-foreground font-mono">{item.value}</div>
        <div
          class="w-full rounded-t min-h-0.5 transition-[height] duration-400"
          style="height:{Math.max(2, (item.value / max) * 140)}px;background:{item.color ?? 'var(--primary)'}"
        ></div>
        <div class="text-[10px] text-dim font-mono truncate max-w-[60px]" title={item.label}>{item.label}</div>
      </div>
    {/each}
  </div>
{/if}
