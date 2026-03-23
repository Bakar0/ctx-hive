<script lang="ts">
  import { formatCompact } from "../format/numbers";

  interface DataPoint {
    label: string;
    value: number;
  }

  interface Series {
    name: string;
    color: string;
    data: DataPoint[];
  }

  interface Props {
    series: Series[];
  }

  let { series }: Props = $props();

  let hoveredIdx = $state<number | null>(null);

  const W = 560;
  const H = 170;
  const PAD = { top: 12, right: 16, bottom: 28, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  let dataLen = $derived(series[0]?.data.length ?? 0);
  let allVals = $derived(series.flatMap((s) => s.data.map((d) => d.value)));
  let maxVal = $derived(Math.max(...allVals, 1));
  let allZero = $derived(allVals.every((v) => v === 0));

  function xScale(i: number): number {
    return PAD.left + (i / Math.max(dataLen - 1, 1)) * plotW;
  }

  function yScale(v: number): number {
    return PAD.top + plotH - (v / maxVal) * plotH;
  }

  function niceStep(max: number, targetTicks: number): number {
    const rough = max / targetTicks;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / pow;
    let step: number;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 5) step = 5;
    else step = 10;
    return Math.max(1, step * pow);
  }

  let step = $derived(niceStep(maxVal, 4));
  let yTicks = $derived.by(() => {
    const ticks: number[] = [];
    for (let v = 0; v <= maxVal + step * 0.1; v += step)
      ticks.push(Math.round(v));
    return ticks;
  });

  let labelEvery = $derived(Math.max(1, Math.floor(dataLen / 7)));

  let tooltipText = $derived.by(() => {
    if (hoveredIdx == null || !series[0]?.data[hoveredIdx]) return "";
    const label = series[0].data[hoveredIdx].label;
    const values = series.map((s) => `${s.name}: ${s.data[hoveredIdx!]?.value ?? 0}`).join(" / ");
    return `${label} \u2014 ${values}`;
  });

  let tooltipLeft = $derived.by(() => {
    if (hoveredIdx == null) return "0px";
    const x = xScale(hoveredIdx);
    return `${Math.min(x, W - 140)}px`;
  });
</script>

{#if !series.length || !series[0]?.data.length || allZero}
  <div class="flex items-center justify-center h-[180px] text-muted-foreground text-xs">
    No activity in this time window
  </div>
{:else}
  <div class="w-full h-[180px] relative">
    <svg
      viewBox="0 0 {W} {H}"
      preserveAspectRatio="xMidYMid meet"
      class="w-full h-full"
    >
      {#each yTicks as tick}
        <line x1={PAD.left} y1={yScale(tick)} x2={W - PAD.right} y2={yScale(tick)} stroke="var(--border)" stroke-dasharray="3,3" />
        <text x={PAD.left - 6} y={yScale(tick) + 3} text-anchor="end" fill="var(--dim)" font-size="10" font-family="var(--font-mono)">{formatCompact(tick)}</text>
      {/each}

      {#each series[0].data as d, i}
        {#if i % labelEvery === 0 || i === dataLen - 1}
          <text x={xScale(i)} y={H - 4} text-anchor="middle" fill="var(--dim)" font-size="10" font-family="var(--font-mono)">{d.label}</text>
        {/if}
      {/each}

      {#each series as s}
        {@const points = s.data.map((d, i) => `${xScale(i)},${yScale(d.value)}`).join(" ")}
        {@const areaPoints = `${xScale(0)},${yScale(0)} ${points} ${xScale(dataLen - 1)},${yScale(0)}`}
        <polygon points={areaPoints} fill={s.color} opacity="0.07" />
        <polyline {points} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      {/each}

      {#each series as s}
        {#each s.data as d, i}
          <circle cx={xScale(i)} cy={yScale(d.value)} r={hoveredIdx === i ? 3.5 : 0} fill={s.color} style="transition:r 0.1s" />
        {/each}
      {/each}

      {#if hoveredIdx != null}
        <line x1={xScale(hoveredIdx)} y1={PAD.top} x2={xScale(hoveredIdx)} y2={PAD.top + plotH} stroke="var(--dim)" stroke-dasharray="2,2" />
      {/if}

      {#each series[0].data as _, i}
        {@const colW = plotW / Math.max(dataLen, 1)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <rect x={xScale(i) - colW / 2} y={PAD.top} width={colW} height={plotH} fill="transparent" onmouseenter={() => (hoveredIdx = i)} onmouseleave={() => (hoveredIdx = null)} />
      {/each}
    </svg>

    <div
      class="line-chart-tooltip"
      class:visible={hoveredIdx != null}
      style="left:{tooltipLeft};top:0px"
    >
      {tooltipText}
    </div>
  </div>
{/if}
