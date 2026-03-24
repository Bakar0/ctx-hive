<script lang="ts">
  import type { PipelineStats } from "../api/types";
  import BarChart from "../charts/BarChart.svelte";
  import StatCard from "../components/StatCard.svelte";
  import { formatDuration } from "../format/time";

  interface Props {
    stats: PipelineStats | null;
  }

  let { stats }: Props = $props();

  let durationBars = $derived.by(() => {
    if (!stats) return [];
    return Object.entries(stats.avgStageDurations)
      .map(([name, ms]) => ({ label: name, value: Math.round(ms / 1000) }))
      .sort((a, b) => b.value - a.value);
  });

  let bottleneck = $derived.by(() => {
    if (durationBars.length === 0) return null;
    return durationBars[0]!;
  });
</script>

{#if stats}
  <div class="mt-6">
    <h2 class="text-sm font-semibold mb-3">Insights</h2>

    <div class="grid grid-cols-4 gap-3 mb-4">
      <StatCard label="Total Runs" value={stats.total} />
      <StatCard label="Completed" value={stats.completed} variant="success" />
      <StatCard label="Failed" value={stats.failed} variant="destructive" />
      <StatCard label="Success Rate" value="{(stats.successRate * 100).toFixed(0)}%" />
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div class="rounded-lg border border-border bg-card p-4">
        <h3 class="text-xs font-semibold text-muted-foreground uppercase mb-3">Avg Stage Duration (seconds)</h3>
        {#if durationBars.length > 0}
          <BarChart data={durationBars} height={120} />
        {:else}
          <p class="text-xs text-muted-foreground">No data yet</p>
        {/if}
      </div>

      <div class="rounded-lg border border-border bg-card p-4">
        <h3 class="text-xs font-semibold text-muted-foreground uppercase mb-3">Stage Failure Rates</h3>
        <div class="space-y-2">
          {#each Object.entries(stats.stageFailureRates) as [name, rate]}
            <div class="flex items-center gap-2">
              <span class="text-xs w-16 text-right font-mono">{name}</span>
              <div class="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  class="h-full rounded-full"
                  style="width:{Math.max(1, rate * 100)}%;background:{rate > 0.1 ? 'var(--destructive)' : 'var(--success)'}"
                ></div>
              </div>
              <span class="text-xs font-mono w-10">{(rate * 100).toFixed(0)}%</span>
            </div>
          {/each}
        </div>

        {#if bottleneck}
          <div class="mt-4 p-2 rounded bg-warning/10 border border-warning/20">
            <p class="text-xs">
              <span class="font-semibold">Bottleneck:</span>
              <span class="font-mono">{bottleneck.label}</span> averages {formatDuration(bottleneck.value * 1000)}
            </p>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
