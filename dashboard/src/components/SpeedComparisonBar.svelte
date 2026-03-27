<script lang="ts">
  interface AlgoTiming {
    name: string;
    durationMs: number;
    color: string;
  }

  interface Props {
    algorithms: AlgoTiming[];
  }

  let { algorithms }: Props = $props();

  let maxDuration = $derived(Math.max(...algorithms.map((a) => a.durationMs), 1));
</script>

<div class="flex flex-col gap-1.5">
  {#each algorithms as algo}
    {@const pct = Math.max(4, (algo.durationMs / maxDuration) * 100)}
    <div class="flex items-center gap-2">
      <span class="text-[10px] font-mono text-muted-foreground w-12 text-right shrink-0">{algo.name}</span>
      <div class="flex-1 h-4 bg-muted/30 rounded-sm overflow-hidden">
        <div
          class="h-full rounded-sm transition-all duration-300 {algo.color}"
          style="width: {pct}%"
        ></div>
      </div>
      <span class="text-[10px] font-mono text-muted-foreground w-14 shrink-0">{algo.durationMs}ms</span>
    </div>
  {/each}
</div>
