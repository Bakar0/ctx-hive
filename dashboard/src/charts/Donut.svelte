<script lang="ts">
  interface Props {
    segments: Record<string, number>;
    colors?: Record<string, string>;
  }

  const defaultColors: Record<string, string> = {
    project: "var(--primary)",
    org: "var(--purple)",
    personal: "var(--success)",
  };

  let { segments, colors = defaultColors }: Props = $props();

  let entries = $derived(Object.entries(segments));
  let total = $derived(entries.reduce((s, [, v]) => s + v, 0) || 1);

  let arcs = $derived.by(() => {
    let offset = 0;
    return entries.map(([scope, count]) => {
      const pct = (count / total) * 100;
      const arc = {
        scope,
        count,
        color: colors[scope] ?? "var(--dim)",
        dasharray: `${pct * 2.827} ${282.7 - pct * 2.827}`,
        dashoffset: `${-offset * 2.827}`,
      };
      offset += pct;
      return arc;
    });
  });
</script>

<div class="flex items-center gap-6">
  <svg viewBox="0 0 120 120" width="120" height="120">
    {#each arcs as arc}
      <circle
        cx="60" cy="60" r="45" fill="none"
        stroke={arc.color} stroke-width="18"
        stroke-dasharray={arc.dasharray}
        stroke-dashoffset={arc.dashoffset}
      />
    {/each}
    <text x="60" y="64" text-anchor="middle" fill="var(--foreground)" font-size="18" font-weight="700" font-family="var(--font-mono)">{total}</text>
  </svg>
  <div class="flex flex-col gap-1.5">
    {#each arcs as arc}
      <div class="flex items-center gap-2 text-xs text-muted-foreground">
        <span class="size-2.5 rounded-full shrink-0" style="background:{arc.color}"></span>
        {arc.scope}
        <span class="font-mono text-foreground ml-auto min-w-6 text-right">{arc.count}</span>
      </div>
    {/each}
  </div>
</div>
