<script lang="ts">
  import { Badge as ShadBadge, type BadgeVariant } from "$lib/components/ui/badge/index.js";

  interface Props {
    variant: NonNullable<BadgeVariant>;
    label?: string;
    pulse?: boolean;
  }

  let { variant, label, pulse = false }: Props = $props();
</script>

<ShadBadge {variant} class={pulse ? "animate-pulse" : ""}>{label ?? variant}</ShadBadge>
