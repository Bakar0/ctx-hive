<script lang="ts">
  import * as Card from "$lib/components/ui/card/index.js";

  interface Props {
    label: string;
    value: string | number;
    sub?: string;
    color?: "green" | "yellow" | "red" | "accent" | "";
  }

  let { label, value, sub, color = "" }: Props = $props();

  const colorClass: Record<string, string> = {
    green: "text-success",
    yellow: "text-warning",
    red: "text-destructive",
    accent: "text-primary",
  };
</script>

<Card.Root class="p-4">
  <div class="text-[11px] text-dim uppercase tracking-wider mb-1.5">{label}</div>
  <div class="text-[28px] font-bold font-mono {colorClass[color] ?? ''}">
    {value}
  </div>
  {#if sub}
    <div class="text-[11px] text-dim font-mono mt-1">{sub}</div>
  {/if}
</Card.Root>
