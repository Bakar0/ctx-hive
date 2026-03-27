<script lang="ts">
  import type { PipelineExecution, PipelineStats } from "../api/types";
  import * as api from "../api/client";
  import StatCard from "../components/StatCard.svelte";
  import Badge from "../components/Badge.svelte";
  import Pagination from "../components/Pagination.svelte";
  import PipelineFlowDiagram from "../pipeline/PipelineFlowDiagram.svelte";
  import StageDetailCard from "../pipeline/StageDetailCard.svelte";
  import PipelineInsights from "../pipeline/PipelineInsights.svelte";
  import { formatDuration, timeAgo } from "../format/time";

  interface Props {
    projects: string[];
  }

  let { projects }: Props = $props();

  let pipelines = $state<PipelineExecution[]>([]);
  let stats = $state<PipelineStats | null>(null);
  let selectedId = $state<string | null>(null);
  let selectedStage = $state<string | null>(null);
  let projectFilter = $state("");
  let statusFilter = $state("");
  let page = $state(1);
  const pageSize = 15;
  let expanded = $state<Set<string>>(new Set());

  let filtered = $derived.by(() => {
    let result = pipelines;
    if (projectFilter !== "") result = result.filter((p) => p.project === projectFilter);
    if (statusFilter !== "") result = result.filter((p) => p.status === statusFilter);
    return result;
  });

  let activePipelines = $derived(filtered.filter((p) => p.status === "running" || p.status === "pending"));

  let selected = $derived(
    pipelines.find((p) => p.id === selectedId)
    ?? activePipelines[0]
    ?? pipelines[0]
    ?? null
  );

  let totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  let pageItems = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));

  // Stats derived from pipelines
  let activeCount = $derived(activePipelines.length);
  let completedCount = $derived(pipelines.filter((p) => p.status === "completed").length);
  let failedCount = $derived(pipelines.filter((p) => p.status === "failed").length);
  let avgDuration = $derived.by(() => {
    const done = pipelines.filter((p) => p.totalDurationMs != null);
    if (done.length === 0) return 0;
    return done.reduce((s, p) => s + (p.totalDurationMs ?? 0), 0) / done.length;
  });
  let totalTokens = $derived(
    pipelines.reduce((s, p) => s + (p.totalInputTokens ?? 0) + (p.totalOutputTokens ?? 0), 0)
  );

  export async function fetchPipelines() {
    try {
      [pipelines, stats] = await Promise.all([
        api.getPipelines({ limit: 100 }),
        api.getPipelineStats(),
      ]);
    } catch {
      // silent
    }
  }

  $effect(() => {
    void fetchPipelines();
  });

  let busyActions = $state<Set<string>>(new Set());

  function toggleExpand(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  async function handleCancel(executionId: string) {
    busyActions = new Set([...busyActions, executionId]);
    try {
      await api.cancelPipeline(executionId);
      await fetchPipelines();
    } finally {
      const next = new Set(busyActions);
      next.delete(executionId);
      busyActions = next;
    }
  }

  async function handleRerun(executionId: string) {
    busyActions = new Set([...busyActions, executionId]);
    try {
      await api.rerunPipeline(executionId);
      await fetchPipelines();
    } finally {
      const next = new Set(busyActions);
      next.delete(executionId);
      busyActions = next;
    }
  }

  function stageProgress(p: PipelineExecution): { text: string; css: string } {
    const completed = p.stages.filter((s) => s.status === "completed").length;
    const total = p.stages.length;
    if (p.status === "completed") return { text: `\u2713 ${completed}/${total}`, css: "text-success" };
    if (p.status === "requeued") return { text: `\u21bb requeued`, css: "text-muted-foreground" };
    if (p.status === "failed") {
      const failed = p.stages.find((s) => s.status === "failed");
      return { text: `\u2717 ${failed?.name ?? "?"} (${completed}/${total})`, css: "text-destructive" };
    }
    if (p.status === "running") {
      const running = p.stages.find((s) => s.status === "running");
      return { text: `${running?.name ?? "?"} \u25b8 (${completed}/${total})`, css: "text-primary" };
    }
    return { text: `0/${total}`, css: "text-muted-foreground" };
  }

  function statusBadge(status: string): "pending" | "processing" | "done" | "failed" | "secondary" {
    switch (status) {
      case "running": return "processing";
      case "completed": return "done";
      case "failed": return "failed";
      case "requeued": return "secondary";
      default: return "pending";
    }
  }
</script>

<div class="mb-6 flex items-center justify-between">
  <div>
    <h1 class="text-xl font-semibold mb-1">Pipeline</h1>
    <p class="text-sm text-muted-foreground">Real-time processing pipeline visualization</p>
  </div>
  <button class="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted transition-colors" onclick={() => fetchPipelines()}>
    Refresh
  </button>
</div>

<!-- Stats Row -->
<div class="grid grid-cols-5 gap-3 mb-5">
  <StatCard label="Active" value={activeCount} variant={activeCount > 0 ? "primary" : undefined} />
  <StatCard label="Completed" value={completedCount} variant="success" />
  <StatCard label="Failed" value={failedCount} variant={failedCount > 0 ? "destructive" : undefined} />
  <StatCard label="Avg Duration" value={avgDuration > 0 ? formatDuration(avgDuration) : "—"} />
  <StatCard label="Total Tokens" value={totalTokens > 0 ? totalTokens.toLocaleString() : "—"} />
</div>

<!-- Active Pipeline Chips -->
{#if activePipelines.length > 0}
  <div class="flex gap-2 mb-4 overflow-x-auto pb-1">
    {#each activePipelines as p}
      <button
        class="shrink-0 px-3 py-1 rounded-full border text-xs font-mono transition-colors
          {selectedId === p.id ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}"
        onclick={() => { selectedId = p.id; selectedStage = null; }}
      >
        <span class="inline-block size-1.5 rounded-full bg-primary animate-pulse mr-1.5"></span>
        {p.project} · {p.pipelineName}
      </button>
    {/each}
  </div>
{/if}

<!-- Flow Diagram -->
<PipelineFlowDiagram pipeline={selected} {selectedStage} onSelectStage={(s) => { selectedStage = s; }} />

<!-- Stage Detail -->
{#if selectedStage && selected}
  {@const stage = selected.stages.find((s) => s.name === selectedStage)}
  {#if stage}
    <StageDetailCard {stage} executionId={selected.id} />
  {/if}
{/if}

<!-- Filters -->
<div class="flex items-center gap-3 mt-6 mb-3">
  <select
    class="text-xs px-2 py-1.5 rounded border border-border bg-card"
    bind:value={projectFilter}
  >
    <option value="">All projects</option>
    {#each projects as p}
      <option value={p}>{p}</option>
    {/each}
  </select>
  <select
    class="text-xs px-2 py-1.5 rounded border border-border bg-card"
    bind:value={statusFilter}
  >
    <option value="">All statuses</option>
    <option value="running">Running</option>
    <option value="completed">Completed</option>
    <option value="failed">Failed</option>
    <option value="requeued">Requeued</option>
  </select>
  <span class="text-xs text-muted-foreground ml-auto">{filtered.length} pipeline{filtered.length !== 1 ? "s" : ""}</span>
</div>

<!-- Pipeline History Table -->
<div class="rounded-lg border border-border overflow-hidden">
  <table class="w-full text-xs">
    <thead class="bg-muted/50">
      <tr>
        <th class="text-left px-3 py-2 font-medium text-muted-foreground w-8"></th>
        <th class="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
        <th class="text-left px-3 py-2 font-medium text-muted-foreground">Type</th>
        <th class="text-left px-3 py-2 font-medium text-muted-foreground">Project</th>
        <th class="text-left px-3 py-2 font-medium text-muted-foreground">Stages</th>
        <th class="text-left px-3 py-2 font-medium text-muted-foreground">Duration</th>
        <th class="text-left px-3 py-2 font-medium text-muted-foreground">Entries</th>
        <th class="text-left px-3 py-2 font-medium text-muted-foreground">Started</th>
        <th class="text-left px-3 py-2 font-medium text-muted-foreground w-20"></th>
      </tr>
    </thead>
    <tbody>
      {#each pageItems as p}
        <tr
          class="border-t border-border hover:bg-muted/30 cursor-pointer transition-colors
            {selectedId === p.id ? 'bg-primary/5' : ''}"
          onclick={() => { selectedId = p.id; selectedStage = null; }}
        >
          <td class="px-3 py-2">
            <button
              class="text-muted-foreground hover:text-foreground text-xs"
              onclick={(e: MouseEvent) => { e.stopPropagation(); toggleExpand(p.id); }}
            >{expanded.has(p.id) ? "▾" : "▸"}</button>
          </td>
          <td class="px-3 py-2"><Badge variant={statusBadge(p.status)} label={p.status} /></td>
          <td class="px-3 py-2 font-mono">{p.pipelineName}</td>
          <td class="px-3 py-2">{p.project}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap {stageProgress(p).css}">
            {stageProgress(p).text}
          </td>
          <td class="px-3 py-2 font-mono">{p.totalDurationMs != null ? formatDuration(p.totalDurationMs) : "—"}</td>
          <td class="px-3 py-2 font-mono">{p.entriesCreated ?? 0}</td>
          <td class="px-3 py-2">{timeAgo(p.startedAt)}</td>
          <td class="px-3 py-2">
            {#if p.status === "running" || p.status === "pending"}
              <button
                class="px-2 py-0.5 rounded text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                disabled={busyActions.has(p.id)}
                onclick={(e: MouseEvent) => { e.stopPropagation(); void handleCancel(p.id); }}
              >Cancel</button>
            {:else if p.status === "failed"}
              <button
                class="px-2 py-0.5 rounded text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                disabled={busyActions.has(p.id)}
                onclick={(e: MouseEvent) => { e.stopPropagation(); void handleRerun(p.id); }}
              >Rerun</button>
            {/if}
          </td>
        </tr>

        {#if expanded.has(p.id)}
          <tr class="border-t border-border bg-muted/20">
            <td colspan="9" class="px-6 py-3">
              <div class="grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs">
                {#each p.stages as stage}
                  <div class="flex items-center gap-2">
                    <Badge variant={statusBadge(stage.status)} label={stage.status} />
                    <span class="font-mono">{stage.name}</span>
                    {#if stage.durationMs != null}
                      <span class="text-muted-foreground">· {formatDuration(stage.durationMs)}</span>
                    {/if}
                    {#if stage.metrics.inputTokens}
                      <span class="text-muted-foreground">· {stage.metrics.inputTokens.toLocaleString()} tok</span>
                    {/if}
                    {#if stage.error}
                      <span class="text-destructive truncate max-w-48" title={stage.error}>{stage.error}</span>
                    {/if}
                  </div>
                {/each}
              </div>
              <div class="mt-2 text-xs text-muted-foreground font-mono">
                ID: {p.id.slice(0, 8)}… · Tokens: {((p.totalInputTokens ?? 0) + (p.totalOutputTokens ?? 0)).toLocaleString()}
              </div>
            </td>
          </tr>
        {/if}
      {/each}

      {#if pageItems.length === 0}
        <tr>
          <td colspan="9" class="px-3 py-8 text-center text-muted-foreground">No pipelines found</td>
        </tr>
      {/if}
    </tbody>
  </table>
</div>

{#if totalPages > 1}
  <div class="mt-3">
    <Pagination currentPage={page} {totalPages} onPageChange={(p) => { page = p; }} />
  </div>
{/if}

<!-- Insights -->
<PipelineInsights {stats} />
