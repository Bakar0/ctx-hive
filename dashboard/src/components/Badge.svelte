<script lang="ts">
  import { Badge as ShadBadge, type BadgeVariant } from "$lib/components/ui/badge/index.js";

  interface Props {
    variant: NonNullable<BadgeVariant>;
    pulse?: boolean;
  }

  let { variant, pulse = false }: Props = $props();
</script>

<ShadBadge {variant} class={pulse ? "animate-pulse" : ""}>{variant}</ShadBadge>
