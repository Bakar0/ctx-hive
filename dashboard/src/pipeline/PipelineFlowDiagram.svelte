<script lang="ts">
  import type { PipelineExecution, StageExecution } from "../api/types";
  import { STAGE_LABELS } from "./stage-labels.ts";
  import { formatDuration } from "../format/time";

  interface Props {
    pipeline: PipelineExecution | null;
    selectedStage: string | null;
    onSelectStage: (stageName: string | null) => void;
  }

  let { pipeline, selectedStage, onSelectStage }: Props = $props();

  interface NodePos {
    name: string;
    label: string;
    x: number;
    y: number;
  }

  const SESSION_NODES: NodePos[] = [
    { name: "ingest", label: STAGE_LABELS["ingest"]!, x: 90, y: 90 },
    { name: "prepare", label: STAGE_LABELS["prepare"]!, x: 260, y: 90 },
    { name: "extract", label: STAGE_LABELS["extract"]!, x: 450, y: 50 },
    { name: "evaluate", label: STAGE_LABELS["evaluate"]!, x: 450, y: 130 },
    { name: "hippocampal-replay", label: STAGE_LABELS["hippocampal-replay"]!, x: 650, y: 90 },
    { name: "summarize", label: STAGE_LABELS["summarize"]!, x: 840, y: 90 },
  ];

  const GIT_NODES: NodePos[] = [
    { name: "ingest", label: STAGE_LABELS["ingest"]!, x: 90, y: 90 },
    { name: "prepare", label: STAGE_LABELS["prepare"]!, x: 270, y: 90 },
    { name: "extract", label: STAGE_LABELS["extract"]!, x: 460, y: 90 },
    { name: "hippocampal-replay", label: STAGE_LABELS["hippocampal-replay"]!, x: 660, y: 90 },
    { name: "summarize", label: STAGE_LABELS["summarize"]!, x: 840, y: 90 },
  ];

  const REPO_NODES: NodePos[] = [
    { name: "ingest", label: STAGE_LABELS["ingest"]!, x: 90, y: 90 },
    { name: "prepare", label: STAGE_LABELS["prepare"]!, x: 270, y: 90 },
    { name: "extract", label: STAGE_LABELS["extract"]!, x: 460, y: 90 },
    { name: "hippocampal-replay", label: STAGE_LABELS["hippocampal-replay"]!, x: 660, y: 90 },
    { name: "summarize", label: STAGE_LABELS["summarize"]!, x: 840, y: 90 },
  ];

  let nodes = $derived.by(() => {
    if (!pipeline) return [];
    if (pipeline.pipelineName === "session-mine") return SESSION_NODES;
    if (pipeline.pipelineName === "repo-sync") return REPO_NODES;
    return GIT_NODES;
  });

  interface Edge {
    from: string;
    to: string;
  }

  let edges = $derived.by((): Edge[] => {
    if (!pipeline) return [];
    if (pipeline.pipelineName === "session-mine") {
      return [
        { from: "ingest", to: "prepare" },
        { from: "prepare", to: "extract" },
        { from: "prepare", to: "evaluate" },
        { from: "extract", to: "hippocampal-replay" },
        { from: "evaluate", to: "hippocampal-replay" },
        { from: "hippocampal-replay", to: "summarize" },
      ];
    }
    return nodes.slice(0, -1).map((_, i) => ({ from: nodes[i]!.name, to: nodes[i + 1]!.name }));
  });

  const NODE_W = 155;
  const NODE_H = 44;
  const NODE_RX = 8;

  function getStage(name: string): StageExecution | undefined {
    return pipeline?.stages.find((s) => s.name === name);
  }

  function statusColor(status: string | undefined): string {
    switch (status) {
      case "running": return "var(--primary)";
      case "completed": return "var(--success)";
      case "failed": return "var(--destructive)";
      case "skipped": return "var(--dim)";
      default: return "var(--muted-foreground)";
    }
  }

  function statusFill(status: string | undefined): string {
    switch (status) {
      case "running": return "rgba(59,130,246,0.12)";
      case "completed": return "rgba(16,185,129,0.12)";
      case "failed": return "rgba(239,68,68,0.12)";
      case "skipped": return "rgba(128,128,128,0.06)";
      default: return "rgba(148,163,184,0.15)";
    }
  }

  function statusIcon(status: string | undefined): string {
    switch (status) {
      case "running": return "⟳";
      case "completed": return "✓";
      case "failed": return "✕";
      case "skipped": return "—";
      default: return "○";
    }
  }

  function getNodePos(name: string): NodePos | undefined {
    return nodes.find((n) => n.name === name);
  }
</script>

{#if pipeline}
  <svg viewBox="0 0 930 180" class="w-full rounded-lg border border-border bg-card" preserveAspectRatio="xMidYMid meet">
    <defs>
      <marker id="arrow" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
        <polygon points="0 0, 10 3.5, 0 7" fill="var(--muted-foreground)" opacity="0.5" />
      </marker>
    </defs>

    {#each edges as edge}
      {@const fromNode = getNodePos(edge.from)}
      {@const toNode = getNodePos(edge.to)}
      {#if fromNode && toNode}
        {@const x1 = fromNode.x + NODE_W / 2}
        {@const y1 = fromNode.y}
        {@const x2 = toNode.x - NODE_W / 2}
        {@const y2 = toNode.y}
        {@const toStatus = getStage(edge.to)?.status}
        <line
          {x1} {y1} {x2} {y2}
          stroke={statusColor(toStatus)}
          stroke-width="1.5"
          stroke-dasharray={toStatus === "pending" || toStatus === undefined ? "6 3" : "none"}
          opacity={toStatus === "pending" || toStatus === undefined ? "0.4" : "0.5"}
          marker-end="url(#arrow)"
        />
      {/if}
    {/each}

    {#each nodes as node}
      {@const stage = getStage(node.name)}
      {@const color = statusColor(stage?.status)}
      {@const fill = statusFill(stage?.status)}
      {@const isSelected = selectedStage === node.name}
      {@const cx = node.x}
      {@const cy = node.y}
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <g
        role="button"
        tabindex="0"
        style="cursor:pointer"
        onclick={() => onSelectStage(selectedStage === node.name ? null : node.name)}
        onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") onSelectStage(selectedStage === node.name ? null : node.name); }}
      >
        <rect
          x={cx - NODE_W / 2} y={cy - NODE_H / 2}
          width={NODE_W} height={NODE_H}
          rx={NODE_RX}
          {fill}
          stroke={color}
          stroke-width={isSelected ? 2.5 : 1.5}
          stroke-dasharray={stage?.status === "skipped" ? "4 3" : "none"}
          style="transition:fill 300ms,stroke 300ms"
          class={stage?.status === "running" ? "animate-pulse" : ""}
        />

        <text
          x={cx - NODE_W / 2 + 12} y={cy + 1}
          font-size="14"
          fill={color}
          dominant-baseline="middle"
          style="transition:fill 300ms"
        >{statusIcon(stage?.status)}</text>

        <text
          x={cx - NODE_W / 2 + 28} y={cy - 3}
          font-size="11"
          fill="var(--foreground)"
          dominant-baseline="middle"
        >{node.label}</text>

        {#if stage?.durationMs != null}
          <text
            x={cx - NODE_W / 2 + 28} y={cy + 12}
            font-size="9"
            fill="var(--muted-foreground)"
            dominant-baseline="middle"
          >{formatDuration(stage.durationMs)}</text>
        {/if}
      </g>
    {/each}
  </svg>
{:else}
  <div class="w-full rounded-lg border border-border bg-card flex items-center justify-center py-16 text-sm text-muted-foreground">
    No pipeline selected
  </div>
{/if}
