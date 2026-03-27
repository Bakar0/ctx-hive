<script lang="ts">
  import type { Algorithm } from "../api/types";

  interface Props {
    algorithm: Algorithm;
    class?: string;
  }

  let { algorithm, class: cls = "" }: Props = $props();

  const styles: Record<Algorithm, string> = {
    fts5: "bg-primary text-white",
    vector: "bg-purple text-white",
  };

  const labels: Record<Algorithm, string> = {
    fts5: "FTS5",
    vector: "Vector",
  };
</script>

<span class="inline-block text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 {styles[algorithm]} {cls}">
  {labels[algorithm]}
</span>
