<script lang="ts">
  import StatCard from "../components/StatCard.svelte";
  import Pagination from "../components/Pagination.svelte";
  import ContextDetail from "../components/ContextDetail.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Badge as ShadBadge } from "$lib/components/ui/badge/index.js";
  import { timeAgo } from "../format/time";
  import * as api from "../api/client";
  import type { SearchRecord, SearchStats } from "../api/types";

  let previewId = $state<string | null>(null);

  let allHistory = $state<SearchRecord[]>([]);
  let stats = $state<SearchStats | null>(null);
  let page = $state(1);
  let expandedIdx = $state<number | null>(null);
  const pageSize = 20;

  let totalPages = $derived(Math.max(1, Math.ceil(allHistory.length / pageSize)));
  let pageItems = $derived(allHistory.slice((page - 1) * pageSize, page * pageSize));

  $effect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  });

  async function fetchData() {
    try {
      const [h, s] = await Promise.all([api.getSearchHistory(), api.getSearchStats()]);
      allHistory = h;
      stats = s;
    } catch { /* silent */ }
  }

  function toggle(idx: number) { expandedIdx = expandedIdx === idx ? null : idx; }

  function sourceBadgeStyle(source: string): { bg: string; label: string } {
    switch (source) {
      case "inject": return { bg: "bg-purple text-white", label: "inject" };
      case "cli": return { bg: "bg-primary text-white", label: "cli" };
      case "api": return { bg: "bg-success text-white", label: "api" };
      default: return { bg: "bg-dim text-white", label: source };
    }
  }

  let hitRate = $derived(stats != null && stats.totalQueries > 0 ? Math.round(((stats.totalQueries - stats.zeroResultQueries) / stats.totalQueries) * 100) : 0);
</script>

<div class="flex items-center justify-between mb-6">
  <div>
    <h1 class="text-xl font-semibold mb-1">Search & Injection</h1>
    <p class="text-sm text-muted-foreground">Search history, injection tracking, and efficiency metrics</p>
  </div>
  <Button variant="outline" onclick={fetchData} class="flex items-center gap-1.5">
    <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
    Refresh
  </Button>
</div>

{#if stats}
  <div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 mb-6">
    <StatCard label="Total Queries" value={stats.totalQueries} />
    <StatCard label="Injections" value={stats.bySource?.inject ?? 0} />
    <StatCard label="CLI Searches" value={stats.bySource?.cli ?? 0} color="accent" />
    <StatCard label="API Searches" value={stats.bySource?.api ?? 0} color="green" />
    <StatCard label="Hit Rate" value="{hitRate}%" color={hitRate >= 80 ? "green" : hitRate >= 50 ? "yellow" : "red"} />
    <StatCard label="Avg Relevance" value={stats.avgScoreOfServed?.toFixed(2) ?? "\u2014"} />
  </div>
{/if}

<Card.Root>
  <div class="p-3 px-4 border-b border-border">
    <h3 class="text-sm font-semibold">Search History</h3>
    <div class="text-xs text-muted-foreground mt-2 flex flex-col gap-1">
      <div><span class="inline-block bg-purple text-white text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 min-w-[42px] text-center">inject</span> auto-injected into Claude on every message</div>
      <div><span class="inline-block bg-primary text-white text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 min-w-[42px] text-center">cli</span> manual <code>ctx-hive search</code> in terminal</div>
      <div><span class="inline-block bg-success text-white text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 min-w-[42px] text-center">api</span> search via daemon REST API</div>
    </div>
  </div>
  <div class="overflow-x-auto">
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head class="w-8"></Table.Head>
          <Table.Head>Time</Table.Head>
          <Table.Head>Source</Table.Head>
          <Table.Head>Query</Table.Head>
          <Table.Head>Project</Table.Head>
          <Table.Head>Results</Table.Head>
          <Table.Head>Tokens</Table.Head>
          <Table.Head>Duration</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#if allHistory.length === 0}
          <Table.Row><Table.Cell colspan={8} class="text-center text-muted-foreground py-8">No search history yet</Table.Cell></Table.Row>
        {:else}
          {#each pageItems as r, i}
            {@const idx = (page - 1) * pageSize + i}
            {@const badge = sourceBadgeStyle(r.source)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <Table.Row class="cursor-pointer" onclick={() => toggle(idx)}>
              <Table.Cell class="w-8 text-center">
                <span class="job-chevron" class:open={expandedIdx === idx}>&#x25B8;</span>
              </Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground" title={new Date(r.timestamp).toLocaleString()}>{timeAgo(r.timestamp)}</Table.Cell>
              <Table.Cell>
                <span class="inline-block {badge.bg} text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 min-w-[42px] text-center">{badge.label}</span>
              </Table.Cell>
              <Table.Cell class="font-mono text-xs max-w-[250px] truncate">{r.query}</Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground">{r.project ?? "\u2014"}</Table.Cell>
              <Table.Cell class="font-mono text-xs {r.resultCount > 0 ? 'text-success' : 'text-destructive'}">{r.resultCount}</Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground">{r.results.reduce((s, x) => s + (x.tokens ?? 0), 0).toLocaleString()}</Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground">{r.durationMs}ms</Table.Cell>
            </Table.Row>
            {#if expandedIdx === idx && r.results?.length}
              <Table.Row class="hover:bg-transparent">
                <Table.Cell colspan={8} class="!p-0">
                  <div class="p-3 pl-12 bg-background border-t border-border">
                    <p class="font-mono text-xs mb-2 whitespace-pre-wrap break-all">{r.query}</p>
                    {#each r.results as result}
                      <!-- svelte-ignore a11y_click_events_have_key_events -->
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <div
                        class="flex items-center gap-2.5 py-1.5 px-2 -mx-2 text-xs rounded cursor-pointer hover:bg-muted/50 transition-colors"
                        onclick={(e) => { e.stopPropagation(); previewId = result.id; }}
                      >
                        <span class="font-mono text-muted-foreground min-w-10">{result.score.toFixed(2)}</span>
                        <span class="text-primary">{result.title}</span>
                        <span class="font-mono text-dim text-[10px]">{result.id}</span>
                      </div>
                    {/each}
                  </div>
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
        {/if}
      </Table.Body>
    </Table.Root>
  </div>
</Card.Root>

<Pagination {page} {totalPages} total={allHistory.length} {pageSize} onPrev={() => (page = Math.max(1, page - 1))} onNext={() => (page = Math.min(totalPages, page + 1))} />

{#if allHistory.length === 0}
  <div class="text-center py-12 text-muted-foreground">
    <div class="text-[32px] mb-3 opacity-40">&#x1F50D;</div>
    <p class="text-sm">No search history yet. Run <code>ctx-hive search</code> or enable the inject hook.</p>
  </div>
{/if}

<ContextDetail contextId={previewId} onClose={() => (previewId = null)} />
