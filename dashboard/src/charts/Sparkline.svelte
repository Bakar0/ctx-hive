<script lang="ts">
  import type { HitBucket } from "../api/types";

  interface Props {
    hits: HitBucket[];
    days?: number;
    wide?: boolean;
  }

  let { hits, days = 30, wide = false }: Props = $props();

  let bars = $derived.by(() => {
    const now = Date.now();
    const buckets: number[] = Array.from({ length: days }, () => 0);
    for (const h of hits) {
      const daysAgo = Math.floor(
        (now - new Date(h.date).getTime()) / 86400000,
      );
      if (daysAgo >= 0 && daysAgo < days) {
        buckets[days - 1 - daysAgo] += h.count;
      }
    }
    const max = Math.max(...buckets, 1);
    return buckets.map((v) => ({
      value: v,
      height: Math.max(v > 0 ? 2 : 0, (v / max) * (wide ? 38 : 18)),
    }));
  });
</script>

<div class="flex items-end gap-px {wide ? 'h-10 mt-2' : 'h-5'}">
  {#each bars as bar}
    <div class="flex-1 bg-primary rounded-[1px] opacity-70" style="height:{bar.height}px"></div>
  {/each}
</div>
