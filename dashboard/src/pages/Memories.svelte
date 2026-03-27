<script lang="ts">
  import StatCard from "../components/StatCard.svelte";
  import Badge from "../components/Badge.svelte";
  import Pagination from "../components/Pagination.svelte";
  import MemoryDetail from "../components/MemoryDetail.svelte";
  import { Badge as ShadBadge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import BarChart from "../charts/BarChart.svelte";

  import StackedBar from "../charts/StackedBar.svelte";
  import Sparkline from "../charts/Sparkline.svelte";
  import { timeAgo } from "../format/time";
  import { formatCompact } from "../format/numbers";
  import * as api from "../api/client";
  import type { MemoryEntry, EntrySignals } from "../api/types";

  interface Props { projects: string[]; }
  let { projects }: Props = $props();

  let selectedId = $state<string | null>(null);

  let allMemories = $state<MemoryEntry[]>([]);
  let allSignals = $state<Record<string, EntrySignals>>({});
  let searchText = $state("");
  let scopeFilter = $state("");
  let projectFilter = $state("");
  let tagFilter = $state("");
  let scoreFilter = $state("");
  let freshnessFilter = $state("");
  let sortBy = $state("newest");
  let page = $state(1);
  const pageSize = 25;

  $effect(() => { fetchMemories(); });

  export async function fetchMemories() {
    try {
      const [ctxRes, sigRes] = await Promise.all([api.getMemories(), api.getSignals()]);
      allMemories = ctxRes;
      allSignals = sigRes.entries ?? {};
    } catch { /* silent */ }
  }

  let allTags = $derived.by(() => {
    const set = new Set<string>();
    for (const c of allMemories) for (const t of c.tags ?? []) set.add(t);
    return [...set].sort();
  });

  function scoreTier(id: string): string {
    const sig = allSignals[id];
    if (!sig) return "none";
    if (sig.score >= 0.6) return "high";
    if (sig.score >= 0.3) return "mid";
    return "low";
  }

  function freshness(id: string): string {
    const sig = allSignals[id];
    if (!sig?.searchHits?.length) return "never";
    const cutoff = Date.now() - 30 * 86400000;
    const recent = sig.searchHits.filter((b) => new Date(b.date).getTime() >= cutoff).reduce((s, b) => s + b.count, 0);
    return recent > 0 ? "active" : "stale";
  }

  function isStale(c: MemoryEntry): boolean {
    const sig = allSignals[c.id];
    const cutoff = Date.now() - 30 * 86400000;
    const updatedOld = new Date(c.updated).getTime() < cutoff;
    if (!sig) return updatedOld;
    const recentHits = (sig.searchHits ?? []).filter((b) => new Date(b.date).getTime() >= cutoff).reduce((s, b) => s + b.count, 0);
    return recentHits === 0 && updatedOld;
  }

  let filtered = $derived.by(() => {
    let list = allMemories;
    if (searchText !== "") {
      const q = searchText.toLowerCase();
      list = list.filter((c) => (c.title ?? "").toLowerCase().includes(q) || (c.tags ?? []).join(" ").toLowerCase().includes(q) || (c.body ?? "").toLowerCase().includes(q));
    }
    if (scopeFilter !== "") list = list.filter((c) => c.scope === scopeFilter);
    if (projectFilter !== "") list = list.filter((c) => c.project === projectFilter);
    if (tagFilter !== "") list = list.filter((c) => (c.tags ?? []).includes(tagFilter));
    if (scoreFilter !== "") list = list.filter((c) => scoreTier(c.id) === scoreFilter);
    if (freshnessFilter !== "") list = list.filter((c) => freshness(c.id) === freshnessFilter);
    list = [...list];
    switch (sortBy) {
      case "oldest": list.sort((a, b) => a.updated.localeCompare(b.updated)); break;
      case "score-desc": list.sort((a, b) => (allSignals[b.id]?.score ?? -1) - (allSignals[a.id]?.score ?? -1)); break;
      case "score-asc": list.sort((a, b) => (allSignals[a.id]?.score ?? 2) - (allSignals[b.id]?.score ?? 2)); break;
      case "alpha": list.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "")); break;
      case "project": list.sort((a, b) => (a.project ?? "").localeCompare(b.project ?? "") || b.updated.localeCompare(a.updated)); break;
      default: list.sort((a, b) => b.updated.localeCompare(a.updated));
    }
    return list;
  });

  let totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  let pageItems = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));

  let stats = $derived.by(() => {
    let scored = 0, totalScore = 0, highCount = 0, lowCount = 0, unscoredCount = 0, staleCount = 0;
    for (const c of allMemories) {
      const sig = allSignals[c.id];
      if (!sig) { unscoredCount++; } else { scored++; totalScore += sig.score; if (sig.score >= 0.6) highCount++; if (sig.score < 0.3) lowCount++; }
      if (isStale(c)) staleCount++;
    }
    return { total: allMemories.length, avgScore: scored > 0 ? totalScore / scored : 0, highCount, lowCount, unscoredCount, staleCount, scored };
  });

  let scoreDist = $derived.by(() => {
    const buckets = Array(10).fill(0) as number[];
    let noData = 0;
    for (const c of allMemories) {
      const sig = allSignals[c.id];
      if (!sig) { noData++; continue; }
      buckets[Math.min(Math.floor(sig.score * 10), 9)]++;
    }
    const items = buckets.map((count, i) => ({ label: (i / 10).toFixed(1), value: count, color: i < 3 ? "var(--destructive)" : i < 6 ? "var(--warning)" : "var(--success)" }));
    if (noData > 0) items.push({ label: "N/A", value: noData, color: "var(--dim)" });
    return items;
  });

  let scopeHealth = $derived.by(() => {
    const data: Record<string, Record<string, number>> = { project: { high: 0, mid: 0, low: 0, none: 0 }, org: { high: 0, mid: 0, low: 0, none: 0 }, personal: { high: 0, mid: 0, low: 0, none: 0 } };
    for (const c of allMemories) { const d = data[c.scope]; if (d != null) d[scoreTier(c.id)]++; }
    return (["project", "org", "personal"] as const).filter((s) => { const d = data[s]!; return d.high + d.mid + d.low + d.none > 0; }).map((s) => {
      const d = data[s]!;
      return { label: s, segments: [{ label: "high", color: "var(--success)", value: d.high }, { label: "mid", color: "var(--warning)", value: d.mid }, { label: "low", color: "var(--destructive)", value: d.low }, { label: "none", color: "var(--dim)", value: d.none }] };
    });
  });

  function scoreBarColor(s: number): string { return s < 0.3 ? "var(--destructive)" : s < 0.6 ? "var(--warning)" : "var(--success)"; }

  async function handleDelete(id: string) {
    if (!confirm("Delete this memory entry? This cannot be undone.")) return;
    try { await api.deleteMemory(id); await fetchMemories(); } catch { /* silent */ }
  }

  function resetPage() { page = 1; }
</script>

<div class="mb-6">
  <h1 class="text-xl font-semibold mb-1">Memories</h1>
  <p class="text-sm text-muted-foreground">Browse and manage your stored memories</p>
</div>

{#if allMemories.length > 0}
  <div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 mb-6">
    <StatCard label="Total Memories" value={stats.total} color="accent" />
    <StatCard label="Avg Score" value={stats.scored > 0 ? stats.avgScore.toFixed(2) : "\u2014"} color={stats.avgScore < 0.3 ? "red" : stats.avgScore < 0.6 ? "yellow" : "green"} />
    <StatCard label="Healthy" value={stats.highCount} color="green" />
    <StatCard label="Needs Review" value={stats.lowCount} color={stats.lowCount > 0 ? "red" : ""} sub="{stats.total > 0 ? Math.round(stats.lowCount / stats.total * 100) : 0}% of total" />
    <StatCard label="Stale" value={stats.staleCount} color={stats.staleCount > 0 ? "yellow" : ""} />
    <StatCard label="Unscored" value={stats.unscoredCount} />
  </div>

  <div class="grid grid-cols-2 gap-4 mb-6 max-[900px]:grid-cols-1">
    <Card.Root class="p-4">
      <div class="text-xs text-muted-foreground uppercase tracking-wider mb-3">Score Distribution</div>
      <BarChart items={scoreDist} />
    </Card.Root>
    <Card.Root class="p-4">
      <div class="text-xs text-muted-foreground uppercase tracking-wider mb-3">Scope Health</div>
      <StackedBar rows={scopeHealth} />
    </Card.Root>
  </div>

  <div class="flex gap-2 items-center flex-wrap mb-4">
    <input class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary min-w-[180px]" type="text" placeholder="Search titles, tags, body..." bind:value={searchText} oninput={resetPage} />
    <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={scopeFilter} onchange={resetPage}>
      <option value="">All scopes</option>
      <option value="project">Project</option><option value="org">Org</option><option value="personal">Personal</option>
    </select>
    <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={projectFilter} onchange={resetPage}>
      <option value="">All projects</option>
      {#each projects as p}<option value={p}>{p}</option>{/each}
    </select>
    <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={tagFilter} onchange={resetPage}>
      <option value="">All tags</option>
      {#each allTags as t}<option value={t}>{t}</option>{/each}
    </select>
    <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={scoreFilter} onchange={resetPage}>
      <option value="">All scores</option>
      <option value="high">High (&ge; 0.6)</option><option value="mid">Mid (0.3 &ndash; 0.6)</option><option value="low">Low (&lt; 0.3)</option><option value="none">No score data</option>
    </select>
    <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={freshnessFilter} onchange={resetPage}>
      <option value="">All freshness</option>
      <option value="active">Active (hits in 30d)</option><option value="stale">Stale (no hits in 30d)</option><option value="never">Never searched</option>
    </select>
    <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={sortBy} onchange={resetPage}>
      <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="score-desc">Score high &rarr; low</option><option value="score-asc">Score low &rarr; high</option><option value="alpha">Alphabetical</option><option value="project">By project</option>
    </select>
  </div>

  <Card.Root>
    <Table.Root>
      <Table.Header>
        <Table.Row><Table.Head>Title</Table.Head><Table.Head>Scope</Table.Head><Table.Head>Project</Table.Head><Table.Head>Tokens</Table.Head><Table.Head>Score</Table.Head><Table.Head>Activity</Table.Head><Table.Head>Updated</Table.Head><Table.Head></Table.Head></Table.Row>
      </Table.Header>
      <Table.Body>
        {#if filtered.length === 0}
          <Table.Row><Table.Cell colspan={8} class="text-center text-muted-foreground py-8">No memories match filters</Table.Cell></Table.Row>
        {:else}
          {#each pageItems as c (c.id)}
            {@const sig = allSignals[c.id]}
            {@const tier = scoreTier(c.id)}
            {@const stale = isStale(c)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <Table.Row class="cursor-pointer {tier === 'low' ? 'ctx-row-low' : stale ? 'ctx-row-stale' : ''}" onclick={() => (selectedId = c.id)}>
              <Table.Cell class="max-w-[380px]">
                <span class="font-medium truncate max-w-[380px] block">{c.title}</span>
                {#if c.body}<div class="text-[11px] text-dim mt-0.5 truncate max-w-[400px]">{c.body.slice(0, 80).replace(/\n/g, " ")}</div>{/if}
                {#if c.tags?.length}<div class="mt-0.5">{#each c.tags as t}<ShadBadge variant="outline" class="text-[10px] h-4 px-1.5 mr-1 mb-0.5">{t}</ShadBadge>{/each}</div>{/if}
              </Table.Cell>
              <Table.Cell><Badge variant={c.scope} /></Table.Cell>
              <Table.Cell class="font-mono text-xs">{c.project || "\u2014"}</Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground">{c.tokens > 0 ? formatCompact(c.tokens) : "\u2014"}</Table.Cell>
              <Table.Cell>
                {#if sig}
                  {@const s = sig.score}
                  <ShadBadge variant={s < 0.3 ? "score-low" : s < 0.6 ? "score-mid" : "score-high"}>{s.toFixed(2)}</ShadBadge>
                  <div class="h-1 w-12 bg-muted rounded-sm overflow-hidden inline-block align-middle ml-1.5">
                    <div class="h-full rounded-sm" style="width:{s * 100}%;background:{scoreBarColor(s)}"></div>
                  </div>
                {:else}
                  <span class="text-dim">&mdash;</span>
                {/if}
              </Table.Cell>
              <Table.Cell>
                {#if sig?.searchHits?.length}
                  <Sparkline hits={sig.searchHits} days={30} />
                {:else}
                  <span class="text-dim text-[11px]">inactive</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground" title={new Date(c.updated).toLocaleString()}>{timeAgo(c.updated)}</Table.Cell>
              <Table.Cell>
                <Button variant="ghost" size="sm" class="h-6 text-[11px] text-dim hover:text-destructive" onclick={(e: MouseEvent) => { e.stopPropagation(); handleDelete(c.id); }}>delete</Button>
              </Table.Cell>
            </Table.Row>
          {/each}
        {/if}
      </Table.Body>
    </Table.Root>
  </Card.Root>

  <Pagination {page} {totalPages} total={filtered.length} {pageSize} onPrev={() => (page = Math.max(1, page - 1))} onNext={() => (page = Math.min(totalPages, page + 1))} />
{:else}
  <div class="text-center py-12 text-muted-foreground">
    <div class="text-[32px] mb-3 opacity-40">&#x1F4ED;</div>
    <p class="text-sm">No memories yet. Run <code class="text-primary">ctx-hive init</code> to auto-generate entries.</p>
  </div>
{/if}

<MemoryDetail memoryId={selectedId} onClose={() => (selectedId = null)} onDelete={() => { selectedId = null; void fetchMemories(); }} />
