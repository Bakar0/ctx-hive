<script lang="ts">
  import StatCard from "../components/StatCard.svelte";
  import Pagination from "../components/Pagination.svelte";
  import ContextDetail from "../components/ContextDetail.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { timeAgo } from "../format/time";
  import * as api from "../api/client";
  import type { SessionSummary } from "../api/types";
  import { RATING_LEGEND } from "$lib/scoring";

  interface Props {
    projects: string[];
  }

  let { projects }: Props = $props();

  let previewId = $state<string | null>(null);
  let sessions = $state<SessionSummary[]>([]);
  let projectFilter = $state("");
  let page = $state(1);
  let expandedId = $state<string | null>(null);
  const pageSize = 20;

  let filtered = $derived.by(() => {
    if (projectFilter === "") return sessions;
    return sessions.filter((s) => s.project === projectFilter);
  });

  let totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  let pageItems = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));

  // Aggregate stats
  let totalSessions = $derived(filtered.length);
  let evaluatedSessions = $derived(filtered.filter((s) => s.evaluationComplete).length);
  let avgRating = $derived.by(() => {
    let sum = 0;
    let count = 0;
    for (const s of filtered) {
      for (const e of s.servedEntries) {
        if (e.rating != null) {
          sum += e.rating;
          count++;
        }
      }
    }
    return count > 0 ? (sum / count).toFixed(2) : "\u2014";
  });

  const RATING_COLORS: Record<string, string> = Object.fromEntries(RATING_LEGEND.map(r => [String(r.rating), r.color]));
  const RATING_LABELS: Record<string, string> = Object.fromEntries(RATING_LEGEND.map(r => [String(r.rating), r.label]));

  $effect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 30000);
    return () => clearInterval(interval);
  });

  export async function fetchSessions() {
    try {
      sessions = await api.getSessions();
    } catch { /* silent */ }
  }

  function toggle(id: string) { expandedId = expandedId === id ? null : id; }

  function ratingsSummary(s: SessionSummary): string {
    const counts: Record<number, number> = {};
    for (const e of s.servedEntries) {
      if (e.rating != null) counts[e.rating] = (counts[e.rating] ?? 0) + 1;
    }
    const parts: string[] = [];
    for (const r of [2, 1, 0, -1]) {
      if (counts[r] != null && counts[r] > 0) {
        const label = RATING_LABELS[String(r)]?.toLowerCase() ?? "?";
        parts.push(`${counts[r]} ${label}`);
      }
    }
    return parts.length > 0 ? parts.join(", ") : "\u2014";
  }

  function evalStatus(s: SessionSummary): { label: string; class: string } {
    if (s.servedEntries.length === 0) return { label: "no entries", class: "text-dim" };
    const rated = s.servedEntries.filter((e) => e.rating != null).length;
    if (rated === 0) return { label: "pending", class: "text-warning" };
    if (s.evaluationComplete) return { label: "complete", class: "text-success" };
    return { label: `${rated}/${s.servedEntries.length}`, class: "text-warning" };
  }
</script>

<div class="flex items-center justify-between mb-6">
  <div>
    <h1 class="text-xl font-semibold mb-1">Evaluations</h1>
    <p class="text-sm text-muted-foreground">Track context injection per session and evaluation results</p>
  </div>
  <Button variant="outline" onclick={fetchSessions} class="flex items-center gap-1.5">
    <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
    Refresh
  </Button>
</div>

<div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 mb-6">
  <StatCard label="Sessions" value={totalSessions} />
  <StatCard label="Evaluated" value={evaluatedSessions} color={evaluatedSessions > 0 ? "green" : ""} />
  <StatCard label="Coverage" value="{totalSessions > 0 ? Math.round((evaluatedSessions / totalSessions) * 100) : 0}%" color={totalSessions > 0 && evaluatedSessions / totalSessions >= 0.8 ? "green" : totalSessions > 0 && evaluatedSessions / totalSessions >= 0.5 ? "yellow" : "red"} />
  <StatCard label="Avg Rating" value={avgRating} />
</div>

<div class="flex gap-2 items-center flex-wrap mb-4">
  <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={projectFilter} onchange={() => (page = 1)}>
    <option value="">All projects</option>
    {#each projects as p}<option value={p}>{p}</option>{/each}
  </select>
  <div class="flex items-center gap-3 ml-auto text-[11px] text-dim">
    <span class="uppercase tracking-wider">Ratings:</span>
    {#each RATING_LEGEND as r}
      <span class="flex items-center gap-1">
        <span class="size-2 rounded-full inline-block" style="background:{r.color}"></span>
        {r.label}
      </span>
    {/each}
  </div>
</div>

<Card.Root>
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head class="w-8"></Table.Head>
        <Table.Head>Time</Table.Head>
        <Table.Head>Project</Table.Head>
        <Table.Head>Entries Served</Table.Head>
        <Table.Head>Injections</Table.Head>
        <Table.Head>Eval Status</Table.Head>
        <Table.Head>Ratings</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#if filtered.length === 0}
        <Table.Row><Table.Cell colspan={7} class="text-center text-muted-foreground py-8">No sessions with injections yet</Table.Cell></Table.Row>
      {:else}
        {#each pageItems as s (s.sessionId)}
          {@const status = evalStatus(s)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <Table.Row class="cursor-pointer {expandedId === s.sessionId ? 'bg-primary/4' : ''}" onclick={() => toggle(s.sessionId)}>
            <Table.Cell class="w-8 text-center">
              <span class="job-chevron" class:open={expandedId === s.sessionId}>&#x25B8;</span>
            </Table.Cell>
            <Table.Cell class="font-mono text-xs text-muted-foreground" title={new Date(s.lastSeen).toLocaleString()}>{timeAgo(s.lastSeen)}</Table.Cell>
            <Table.Cell class="font-mono text-xs">{s.project}</Table.Cell>
            <Table.Cell class="font-mono text-xs">{s.servedEntries.length}</Table.Cell>
            <Table.Cell class="font-mono text-xs text-muted-foreground">{s.injectionCount}</Table.Cell>
            <Table.Cell class="text-xs font-medium {status.class}">{status.label}</Table.Cell>
            <Table.Cell class="text-xs text-muted-foreground">{ratingsSummary(s)}</Table.Cell>
          </Table.Row>
          {#if expandedId === s.sessionId}
            <Table.Row class="hover:bg-transparent">
              <Table.Cell colspan={7} class="!p-0">
                <div class="p-3 pl-12 bg-background border-t border-border">
                  <div class="font-mono text-[11px] text-dim mb-2">Session: {s.sessionId}</div>
                  {#if s.servedEntries.length === 0}
                    <div class="text-xs text-muted-foreground">No entries served</div>
                  {:else}
                    {#each s.servedEntries as entry}
                      <!-- svelte-ignore a11y_click_events_have_key_events -->
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <div
                        class="flex items-start gap-2.5 py-1.5 px-2 -mx-2 text-xs rounded cursor-pointer hover:bg-muted/50 transition-colors"
                        onclick={(e) => { e.stopPropagation(); previewId = entry.id; }}
                      >
                        <span class="size-2.5 rounded-full shrink-0 mt-0.5" style="background:{entry.rating != null ? (RATING_COLORS[String(entry.rating)] ?? 'var(--dim)') : 'var(--muted)'};" title={entry.rating != null ? (RATING_LABELS[String(entry.rating)] ?? "?") : "not evaluated"}></span>
                        <span class="font-mono text-muted-foreground min-w-10">{entry.maxScore.toFixed(2)}</span>
                        <span class="text-primary flex-1">{entry.title}</span>
                        {#if entry.rating != null}
                          <span class="text-[11px] font-medium" style="color:{RATING_COLORS[String(entry.rating)] ?? 'var(--dim)'}">{RATING_LABELS[String(entry.rating)]?.toLowerCase() ?? "?"}</span>
                        {:else}
                          <span class="text-[11px] text-dim">pending</span>
                        {/if}
                        <span class="font-mono text-dim text-[10px]">{entry.id}</span>
                      </div>
                      {#if entry.reason}
                        <div class="text-[11px] text-dim ml-7 mb-1">{entry.reason}</div>
                      {/if}
                    {/each}
                  {/if}
                </div>
              </Table.Cell>
            </Table.Row>
          {/if}
        {/each}
      {/if}
    </Table.Body>
  </Table.Root>
</Card.Root>

<Pagination {page} {totalPages} total={filtered.length} {pageSize} onPrev={() => (page = Math.max(1, page - 1))} onNext={() => (page = Math.min(totalPages, page + 1))} />

<ContextDetail contextId={previewId} onClose={() => (previewId = null)} />
