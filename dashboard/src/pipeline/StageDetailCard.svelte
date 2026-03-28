<script lang="ts">
  import type { StageExecution } from "../api/types";
  import * as api from "../api/client";
  import Badge from "../components/Badge.svelte";
  import MemoryDetail from "../components/MemoryDetail.svelte";
  import { STAGE_LABELS } from "./stage-labels.ts";
  import { formatDuration, timeAgo } from "../format/time";
  import { renderMarkdown } from "../format/markdown";

  const STAGE_DESCRIPTIONS: Record<string, string> = {
    ingest: "Load and parse data from external sources",
    prepare: "Serve relevant memory entries to the session",
    extract: "Run AI agent to extract knowledge entries",
    evaluate: "Score relevance of served memory entries",
    "hippocampal-replay": "Replay existing memories — update stale, remove outdated, merge duplicates",
    summarize: "Aggregate results and finalize metrics",
  };

  interface Props {
    stage: StageExecution;
    executionId: string;
  }

  let { stage, executionId }: Props = $props();

  let previewId = $state<string | null>(null);

  function badgeVariant(status: string): "pending" | "processing" | "done" | "failed" {
    switch (status) {
      case "running": return "processing";
      case "completed": return "done";
      case "failed": return "failed";
      default: return "pending";
    }
  }

  let elapsed = $state(0);
  let interval: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    if (stage.status === "running" && stage.startedAt) {
      const start = new Date(stage.startedAt).getTime();
      interval = setInterval(() => { elapsed = Date.now() - start; }, 200);
    }
    return () => { if (interval) clearInterval(interval); };
  });

  // ── Stage output preview ──────────────────────────────────────────

  let outputData = $state<Record<string, unknown> | null>(null);
  let outputLoading = $state(false);

  $effect(() => {
    const id = executionId;
    const name = stage.name;
    const status = stage.status;

    if (status === "completed" || status === "failed") {
      outputLoading = true;
      api.getStageMessage(id, name)
        .then((data) => { outputData = data as Record<string, unknown>; })
        .catch(() => { outputData = null; })
        .finally(() => { outputLoading = false; });
    } else {
      outputData = null;
    }
  });

  interface PreviewField {
    label: string;
    value: string;
    type: "text" | "code" | "number" | "entries" | "markdown";
    entries?: { id: string; title: string }[];
  }

  let previewFields = $derived.by((): PreviewField[] => {
    if (!outputData) return [];
    const fields: PreviewField[] = [];
    const d = outputData;

    if (stage.name === "ingest") {
      const meta = d.meta as { name?: string } | undefined;
      if (meta?.name) fields.push({ label: "Project", value: meta.name, type: "text" });
      if (typeof d.transcriptTokens === "number") fields.push({ label: "Transcript Tokens", value: d.transcriptTokens.toLocaleString(), type: "number" });
      if (typeof d.isUpdate === "boolean") fields.push({ label: "Update", value: d.isUpdate ? "Yes" : "No", type: "text" });
      if (Array.isArray(d.servedEntries)) fields.push({ label: "Served Entries", value: String(d.servedEntries.length), type: "number" });
      const cd = d.changeDetails as { commitMessages?: string; changedFiles?: string } | undefined;
      if (cd?.commitMessages) fields.push({ label: "Commits", value: cd.commitMessages, type: "code" });
      if (cd?.changedFiles) fields.push({ label: "Changed Files", value: cd.changedFiles, type: "code" });
      const rc = d.repoContext as { readme?: string; claudeMd?: string } | undefined;
      if (rc?.readme) fields.push({ label: "README", value: `${rc.readme.length} chars`, type: "number" });
      if (rc?.claudeMd) fields.push({ label: "CLAUDE.md", value: `${rc.claudeMd.length} chars`, type: "number" });
    }

    if (stage.name === "prepare") {
      // Session prepare: injected entries
      if (typeof d.injectionCount === "number") fields.push({ label: "Memory Entries Served", value: String(d.injectionCount), type: "number" });
      if (Array.isArray(d.injectedEntries)) {
        const entries = (d.injectedEntries as { id?: string; title?: string }[]).filter((e) => e.id && e.title);
        if (entries.length > 0) fields.push({ label: "Served Entries", value: "", type: "entries", entries: entries as { id: string; title: string }[] });
      }
      // Git/repo prepare: existing memory entries
      if (typeof d.existingCount === "number") fields.push({ label: "Existing Entries", value: String(d.existingCount), type: "number" });
      if (Array.isArray(d.existingEntries)) {
        const entries = (d.existingEntries as { id?: string; title?: string }[]).filter((e) => e.id && e.title);
        if (entries.length > 0) fields.push({ label: "Memory Entries", value: "", type: "entries", entries: entries as { id: string; title: string }[] });
      }
    }

    if (stage.name === "extract") {
      if (typeof d.entriesCreated === "number") fields.push({ label: "Entries Created", value: String(d.entriesCreated), type: "number" });
      if (Array.isArray(d.createdEntries)) {
        const entries = (d.createdEntries as { id?: string; title?: string }[]).filter((e) => e.id && e.title);
        if (entries.length > 0) fields.push({ label: "Created Entries", value: "", type: "entries", entries: entries as { id: string; title: string }[] });
      }
      if (typeof d.resultText === "string" && d.resultText.length > 0) fields.push({ label: "Agent Output", value: d.resultText, type: "markdown" });
      if (typeof d.costUsd === "number") fields.push({ label: "Cost", value: `$${d.costUsd.toFixed(4)}`, type: "number" });
    }

    if (stage.name === "evaluate") {
      if (typeof d.resultText === "string" && d.resultText.length > 0) fields.push({ label: "Evaluation", value: d.resultText, type: "markdown" });
      if (typeof d.costUsd === "number") fields.push({ label: "Cost", value: `$${d.costUsd.toFixed(4)}`, type: "number" });
    }

    if (stage.name === "hippocampal-replay") {
      if (typeof d.entriesDeleted === "number") fields.push({ label: "Entries Deleted", value: String(d.entriesDeleted), type: "number" });
      if (typeof d.entriesUpdated === "number") fields.push({ label: "Entries Updated", value: String(d.entriesUpdated), type: "number" });
      if (typeof d.resultText === "string" && d.resultText.length > 0) fields.push({ label: "Agent Output", value: d.resultText, type: "markdown" });
      if (typeof d.costUsd === "number") fields.push({ label: "Cost", value: `$${d.costUsd.toFixed(4)}`, type: "number" });
    }

    if (stage.name === "summarize") {
      if (typeof d.entriesCreated === "number") fields.push({ label: "Entries Created", value: String(d.entriesCreated), type: "number" });
      if (typeof d.entriesDeleted === "number" && d.entriesDeleted > 0) fields.push({ label: "Entries Deleted", value: String(d.entriesDeleted), type: "number" });
      if (typeof d.entriesUpdated === "number" && d.entriesUpdated > 0) fields.push({ label: "Entries Updated", value: String(d.entriesUpdated), type: "number" });
      if (typeof d.inputTokens === "number") fields.push({ label: "Total Input Tokens", value: d.inputTokens.toLocaleString(), type: "number" });
      if (typeof d.outputTokens === "number") fields.push({ label: "Total Output Tokens", value: d.outputTokens.toLocaleString(), type: "number" });
    }

    return fields;
  });

  let expandedCode = $state(false);
  const CODE_PREVIEW_LIMIT = 300;
</script>

<div class="rounded-lg border border-border bg-card p-4 mt-4">
  <div class="flex items-center gap-2 mb-3">
    <span class="text-sm font-semibold">{STAGE_LABELS[stage.name] ?? stage.name}</span>
    <Badge variant={badgeVariant(stage.status)} label={stage.status} />
    {#if stage.retryCount > 0}
      <span class="text-xs text-muted-foreground">retry #{stage.retryCount}</span>
    {/if}
  </div>
  {#if STAGE_DESCRIPTIONS[stage.name]}
    <p class="text-xs text-muted-foreground -mt-2 mb-3">{STAGE_DESCRIPTIONS[stage.name]}</p>
  {/if}

  <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
    <div>
      <span class="text-muted-foreground uppercase tracking-wide">Duration</span>
      <p class="font-mono text-sm font-semibold mt-0.5">
        {#if stage.status === "running"}
          {formatDuration(elapsed)}
        {:else if stage.durationMs != null}
          {formatDuration(stage.durationMs)}
        {:else}
          —
        {/if}
      </p>
    </div>

    <div>
      <span class="text-muted-foreground uppercase tracking-wide">Started</span>
      <p class="text-sm mt-0.5">{timeAgo(stage.startedAt)}</p>
    </div>

    {#if stage.metrics.inputTokens != null || stage.metrics.outputTokens != null}
      <div>
        <span class="text-muted-foreground uppercase tracking-wide">Input Tokens</span>
        <p class="font-mono text-sm mt-0.5">{(stage.metrics.inputTokens ?? 0).toLocaleString()}</p>
      </div>
      <div>
        <span class="text-muted-foreground uppercase tracking-wide">Output Tokens</span>
        <p class="font-mono text-sm mt-0.5">{(stage.metrics.outputTokens ?? 0).toLocaleString()}</p>
      </div>
    {/if}

    {#if stage.metrics.itemsProcessed != null}
      <div>
        <span class="text-muted-foreground uppercase tracking-wide">Items Processed</span>
        <p class="font-mono text-sm mt-0.5">{stage.metrics.itemsProcessed}</p>
      </div>
    {/if}

    {#if stage.metrics.costUsd != null}
      <div>
        <span class="text-muted-foreground uppercase tracking-wide">Cost</span>
        <p class="font-mono text-sm mt-0.5">${stage.metrics.costUsd.toFixed(4)}</p>
      </div>
    {/if}
  </div>

  {#if stage.error}
    <div class="mt-3 p-2 rounded bg-destructive/10 border border-destructive/20">
      <p class="text-xs text-destructive font-mono break-all">{stage.error}</p>
    </div>
  {/if}

  <!-- Stage Output Preview -->
  {#if outputLoading}
    <div class="mt-3 pt-3 border-t border-border">
      <p class="text-xs text-muted-foreground">Loading output...</p>
    </div>
  {:else if previewFields.length > 0}
    <div class="mt-3 pt-3 border-t border-border">
      <p class="text-xs text-muted-foreground uppercase tracking-wide mb-2">Output</p>
      <div class="space-y-2">
        {#each previewFields as field}
          {#if field.type === "code"}
            <div>
              <span class="text-xs text-muted-foreground">{field.label}</span>
              <pre class="mt-1 p-2 rounded bg-muted/50 text-xs font-mono overflow-x-auto max-h-48 whitespace-pre-wrap break-all">{#if field.value.length > CODE_PREVIEW_LIMIT && !expandedCode}{field.value.slice(0, CODE_PREVIEW_LIMIT)}...{:else}{field.value}{/if}</pre>
              {#if field.value.length > CODE_PREVIEW_LIMIT}
                <button
                  class="text-xs text-primary mt-1 hover:underline"
                  onclick={() => { expandedCode = !expandedCode; }}
                >{expandedCode ? "Show less" : "Show more"}</button>
              {/if}
            </div>
          {:else if field.type === "markdown"}
            <div>
              <span class="text-xs text-muted-foreground">{field.label}</span>
              {#if field.value.length > CODE_PREVIEW_LIMIT && !expandedCode}
                <div class="mt-1 p-2 rounded bg-muted/50 text-xs prose prose-invert prose-sm max-w-none overflow-hidden max-h-32">
                  {@html renderMarkdown(field.value.slice(0, CODE_PREVIEW_LIMIT) + "...")}
                </div>
              {:else}
                <div class="mt-1 p-2 rounded bg-muted/50 text-xs prose prose-invert prose-sm max-w-none max-h-48 overflow-y-auto">
                  {@html renderMarkdown(field.value)}
                </div>
              {/if}
              {#if field.value.length > CODE_PREVIEW_LIMIT}
                <button class="text-xs text-primary mt-1 hover:underline"
                  onclick={() => { expandedCode = !expandedCode; }}
                >{expandedCode ? "Show less" : "Show more"}</button>
              {/if}
            </div>
          {:else if field.type === "entries" && field.entries}
            <div>
              <span class="text-xs text-muted-foreground">{field.label}</span>
              <div class="mt-1 space-y-0.5">
                {#each field.entries as entry}
                  <button
                    class="flex items-center gap-2 text-xs px-2 py-1 -mx-2 rounded hover:bg-muted/50 transition-colors w-full text-left"
                    onclick={() => { previewId = entry.id; }}
                  >
                    <span class="text-primary">{entry.title}</span>
                    <span class="font-mono text-dim text-[10px]">{entry.id}</span>
                  </button>
                {/each}
              </div>
            </div>
          {:else}
            <div class="flex items-baseline gap-2 text-xs">
              <span class="text-muted-foreground">{field.label}:</span>
              <span class="font-mono">{field.value}</span>
            </div>
          {/if}
        {/each}
      </div>
    </div>
  {/if}
</div>

<MemoryDetail memoryId={previewId} onClose={() => { previewId = null; }} />
