<script lang="ts">
  import StatCard from "../components/StatCard.svelte";
  import Pagination from "../components/Pagination.svelte";
  import MemoryDetail from "../components/MemoryDetail.svelte";
  import AlgorithmBadge from "../components/AlgorithmBadge.svelte";
  import LineChart from "../charts/LineChart.svelte";
  import BarChart from "../charts/BarChart.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { timeAgo } from "../format/time";
  import * as api from "../api/client";
  import type { SearchRecord, SearchStats, SearchAnalytics } from "../api/types";

  let previewId = $state<string | null>(null);

  // ── History state ────────────────────────────────────────
  let allHistory = $state<SearchRecord[]>([]);
  let stats = $state<SearchStats | null>(null);
  let analytics = $state<SearchAnalytics | null>(null);
  let page = $state(1);
  let expandedIdx = $state<number | null>(null);
  const pageSize = 20;

  let totalPages = $derived(Math.max(1, Math.ceil(allHistory.length / pageSize)));
  let pageItems = $derived(allHistory.slice((page - 1) * pageSize, page * pageSize));
  let hitRate = $derived(stats != null && stats.totalQueries > 0 ? Math.round(((stats.totalQueries - stats.zeroResultQueries) / stats.totalQueries) * 100) : 0);

  // ── Chart data ─────────────────────────────────────────
  let speedSeries = $derived.by(() => {
    if (!analytics?.speedTrend.length) return [];
    const fts: { label: string; value: number }[] = [];
    const vec: { label: string; value: number }[] = [];
    for (const p of analytics.speedTrend) {
      const label = p.date.slice(5); // "MM-DD"
      fts.push({ label, value: Math.round(p.avgFtsDurationMs ?? 0) });
      vec.push({ label, value: Math.round(p.avgVectorDurationMs ?? 0) });
    }
    const series: { name: string; color: string; data: { label: string; value: number }[] }[] = [
      { name: "FTS5", color: "var(--primary)", data: fts },
    ];
    if (vec.some((v) => v.value > 0)) {
      series.push({ name: "Vector", color: "var(--purple)", data: vec });
    }
    return series;
  });

  let evalItems = $derived.by(() => {
    if (!analytics?.evaluationByAlgorithm) return [];
    const items: { label: string; value: number; color: string }[] = [];
    const data = analytics.evaluationByAlgorithm;
    if (data.fts5 && data.fts5.totalEvaluated > 0) {
      items.push({ label: `FTS5 (${data.fts5.totalEvaluated})`, value: Number(data.fts5.avgRating.toFixed(2)), color: "var(--primary)" });
    }
    if (data.vector && data.vector.totalEvaluated > 0) {
      items.push({ label: `Vector (${data.vector.totalEvaluated})`, value: Number(data.vector.avgRating.toFixed(2)), color: "var(--purple)" });
    }
    return items;
  });

  // ── Data fetching ──────────────────────────────────────
  $effect(() => {
    fetchHistory();
    fetchAnalytics();
    const interval = setInterval(fetchHistory, 30000);
    return () => clearInterval(interval);
  });

  async function fetchHistory() {
    try {
      const [h, s] = await Promise.all([api.getSearchHistory(), api.getSearchStats()]);
      allHistory = h;
      stats = s;
    } catch { /* silent */ }
  }

  async function fetchAnalytics() {
    try {
      analytics = await api.getSearchAnalytics();
    } catch { /* silent */ }
  }

  // ── Helpers ────────────────────────────────────────────
  function toggle(idx: number) { expandedIdx = expandedIdx === idx ? null : idx; }

  function sourceBadgeStyle(source: string): { bg: string; label: string } {
    switch (source) {
      case "inject": return { bg: "bg-purple text-white", label: "inject" };
      case "cli": return { bg: "bg-primary text-white", label: "cli" };
      case "api": return { bg: "bg-success text-white", label: "api" };
      default: return { bg: "bg-dim text-white", label: source };
    }
  }

  export function fetchData() {
    fetchHistory();
    fetchAnalytics();
  }
</script>

<div class="flex items-center justify-between mb-6">
  <div>
    <h1 class="text-xl font-semibold mb-1">Search</h1>
    <p class="text-sm text-muted-foreground">Search history, algorithm performance, and evaluation metrics</p>
  </div>
</div>

<!-- ── Stat cards ────────────────────────────────────────── -->
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

<!-- ── Charts ────────────────────────────────────────────── -->
<div class="grid grid-cols-2 gap-4 mb-6">
  <Card.Root>
    <div class="p-4 border-b border-border">
      <h3 class="text-sm font-semibold">Algorithm Speed</h3>
      <p class="text-xs text-muted-foreground mt-0.5">Avg duration per day (ms)</p>
    </div>
    <div class="p-4">
      <LineChart series={speedSeries} />
    </div>
  </Card.Root>

  <Card.Root>
    <div class="p-4 border-b border-border">
      <h3 class="text-sm font-semibold">Evaluation by Algorithm</h3>
      <p class="text-xs text-muted-foreground mt-0.5">Avg relevance rating (-1 to 2)</p>
    </div>
    <div class="p-4">
      {#if evalItems.length > 0}
        <BarChart items={evalItems} />
      {:else}
        <div class="flex items-center justify-center h-40 text-muted-foreground text-xs">
          No evaluation data yet — appears after sessions close
        </div>
      {/if}
    </div>
  </Card.Root>
</div>

<!-- ── Search history table ──────────────────────────────── -->
<Card.Root>
  <div class="p-3 px-4 border-b border-border flex items-center justify-between">
    <h3 class="text-sm font-semibold">Search History</h3>
    <Button variant="outline" size="sm" onclick={fetchHistory} class="flex items-center gap-1.5">
      <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
      Refresh
    </Button>
  </div>
  <div class="overflow-x-auto">
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head class="w-8"></Table.Head>
          <Table.Head>Time</Table.Head>
          <Table.Head>Source</Table.Head>
          <Table.Head>Query</Table.Head>
          <Table.Head>Results</Table.Head>
          <Table.Head>FTS5</Table.Head>
          <Table.Head>FTS5 Tok</Table.Head>
          <Table.Head>Vector</Table.Head>
          <Table.Head>Vec Tok</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#if allHistory.length === 0}
          <Table.Row><Table.Cell colspan={9} class="text-center text-muted-foreground py-8">No search history yet</Table.Cell></Table.Row>
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
              <Table.Cell class="font-mono text-xs {r.resultCount > 0 ? 'text-success' : 'text-destructive'}">{r.resultCount}</Table.Cell>
              {@const ftsTok = r.results?.filter((res) => res.algorithm == null || res.algorithm.includes("fts5")).reduce((sum, res) => sum + (res.tokens ?? 0), 0) ?? 0}
              {@const vecTok = r.results?.filter((res) => res.algorithm != null && res.algorithm.includes("vector")).reduce((sum, res) => sum + (res.tokens ?? 0), 0) ?? 0}
              <Table.Cell class="font-mono text-xs text-muted-foreground">{r.ftsDurationMs != null ? `${r.ftsDurationMs}ms` : "\u2014"}</Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground">{ftsTok > 0 ? ftsTok : "\u2014"}</Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground">{r.vectorDurationMs != null ? `${r.vectorDurationMs}ms` : "\u2014"}</Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground">{vecTok > 0 ? vecTok : "\u2014"}</Table.Cell>
            </Table.Row>
            {#if expandedIdx === idx && r.results?.length}
              <Table.Row class="hover:bg-transparent">
                <Table.Cell colspan={9} class="!p-0">
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
                        {#if result.algorithm}
                          {#each result.algorithm.split(",") as algo}
                            {#if algo === "fts5" || algo === "vector"}
                              <AlgorithmBadge algorithm={algo as "fts5" | "vector"} />
                            {/if}
                          {/each}
                        {/if}
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

<!-- Source badge legend -->
<Card.Root class="p-4 mt-4">
  <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Search Sources</h3>
  <div class="text-xs text-muted-foreground flex flex-col gap-1">
    <div><span class="inline-block bg-purple text-white text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 min-w-[42px] text-center">inject</span> auto-injected into Claude on every message</div>
    <div><span class="inline-block bg-primary text-white text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 min-w-[42px] text-center">cli</span> manual <code>ctx-hive search</code> in terminal</div>
    <div><span class="inline-block bg-success text-white text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 min-w-[42px] text-center">api</span> search via daemon REST API or dashboard</div>
  </div>
</Card.Root>

<MemoryDetail memoryId={previewId} onClose={() => (previewId = null)} />
