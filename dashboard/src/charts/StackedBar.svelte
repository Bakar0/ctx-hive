<script lang="ts">
  interface Segment {
    label: string;
    color: string;
    value: number;
  }

  interface Row {
    label: string;
    segments: Segment[];
  }

  interface Props {
    rows: Row[];
  }

  let { rows }: Props = $props();
</script>

{#each rows as row}
  {@const total = row.segments.reduce((s, seg) => s + seg.value, 0) || 1}
  <div class="flex items-center gap-3 mb-2">
    <span class="text-xs text-muted-foreground min-w-16 font-mono">{row.label}</span>
    <div class="flex-1">
      <div class="flex h-5 rounded overflow-hidden bg-muted">
        {#each row.segments as seg}
          <div
            class="h-full min-w-0.5 transition-[width] duration-300"
            style="width:{(seg.value / total) * 100}%;background:{seg.color}"
            title="{seg.label}: {seg.value}"
          ></div>
        {/each}
      </div>
    </div>
    <span class="text-[11px] text-dim min-w-7 text-right font-mono">{row.segments.reduce((s, seg) => s + seg.value, 0)}</span>
  </div>
{/each}
