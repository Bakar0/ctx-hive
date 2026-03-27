<script lang="ts">
  import StatCard from "../components/StatCard.svelte";
  import Pagination from "../components/Pagination.svelte";
  import MemoryDetail from "../components/MemoryDetail.svelte";
  import AlgorithmBadge from "../components/AlgorithmBadge.svelte";
  import SpeedComparisonBar from "../components/SpeedComparisonBar.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import { timeAgo } from "../format/time";
  import * as api from "../api/client";
  import type { SearchRecord, SearchStats, MultiSearchResponse, VectorSearchSettings, BackfillStatus, Algorithm } from "../api/types";

  let previewId = $state<string | null>(null);

  // ── Live Search state ────────────────────────────────────
  let searchQuery = $state("");
  let searchResults = $state<MultiSearchResponse | null>(null);
  let searchLoading = $state(false);
  let viewMode = $state<"merged" | "split">("merged");
  let debounceTimer = $state<ReturnType<typeof setTimeout> | null>(null);

  // ── History state ────────────────────────────────────────
  let allHistory = $state<SearchRecord[]>([]);
  let stats = $state<SearchStats | null>(null);
  let page = $state(1);
  let expandedIdx = $state<number | null>(null);
  const pageSize = 20;

  let totalPages = $derived(Math.max(1, Math.ceil(allHistory.length / pageSize)));
  let pageItems = $derived(allHistory.slice((page - 1) * pageSize, page * pageSize));

  // ── Settings state ───────────────────────────────────────
  let vecSettings = $state<VectorSearchSettings | null>(null);
  let backfillStatus = $state<BackfillStatus | null>(null);
  let apiKeyInput = $state("");
  let savingSettings = $state(false);
  let settingsError = $state("");
  let settingsSuccess = $state("");
  let backfillPolling = $state<ReturnType<typeof setInterval> | null>(null);

  let hitRate = $derived(stats != null && stats.totalQueries > 0 ? Math.round(((stats.totalQueries - stats.zeroResultQueries) / stats.totalQueries) * 100) : 0);
  let vectorCoverage = $derived(vecSettings != null && vecSettings.totalCount > 0 ? Math.round((vecSettings.embeddedCount / vecSettings.totalCount) * 100) : 0);

  // ── Data fetching ────────────────────────────────────────
  $effect(() => {
    fetchHistory();
    fetchSettings();
    const interval = setInterval(fetchHistory, 30000);
    return () => {
      clearInterval(interval);
      if (backfillPolling !== null) clearInterval(backfillPolling);
    };
  });

  async function fetchHistory() {
    try {
      const [h, s] = await Promise.all([api.getSearchHistory(), api.getSearchStats()]);
      allHistory = h;
      stats = s;
    } catch { /* silent */ }
  }

  async function fetchSettings() {
    try {
      vecSettings = await api.getVectorSearchSettings();
      backfillStatus = await api.getBackfillStatus();
    } catch { /* silent */ }
  }

  // ── Live search ──────────────────────────────────────────
  function onSearchInput(e: Event) {
    const target = e.target as HTMLInputElement;
    searchQuery = target.value;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (searchQuery.trim() === "") {
      searchResults = null;
      return;
    }
    debounceTimer = setTimeout(executeSearch, 300);
  }

  async function executeSearch() {
    if (searchQuery.trim() === "") return;
    searchLoading = true;
    try {
      searchResults = await api.searchEntries({ q: searchQuery, limit: 10 });
    } catch { /* silent */ }
    searchLoading = false;
  }

  // ── Settings actions ─────────────────────────────────────
  async function saveSettings() {
    savingSettings = true;
    settingsError = "";
    settingsSuccess = "";
    try {
      const update: { enabled?: boolean; apiKey?: string } = {};
      if (apiKeyInput !== "") update.apiKey = apiKeyInput;
      update.enabled = true;
      const res = await api.updateVectorSearchSettings(update);
      if ("error" in res && res.error) {
        settingsError = res.error;
      } else {
        settingsSuccess = "Settings saved";
        apiKeyInput = "";
        await fetchSettings();
        if (res.backfillStarted) startBackfillPolling();
      }
    } catch (err) {
      settingsError = String(err);
    }
    savingSettings = false;
  }

  async function disableVector() {
    savingSettings = true;
    settingsError = "";
    settingsSuccess = "";
    try {
      await api.updateVectorSearchSettings({ enabled: false });
      settingsSuccess = "Vector search disabled";
      await fetchSettings();
    } catch (err) {
      settingsError = String(err);
    }
    savingSettings = false;
  }

  async function triggerBackfill() {
    try {
      await api.triggerBackfill();
      startBackfillPolling();
    } catch { /* silent */ }
  }

  function startBackfillPolling() {
    if (backfillPolling !== null) return;
    backfillPolling = setInterval(async () => {
      try {
        backfillStatus = await api.getBackfillStatus();
        if (backfillStatus !== null && !backfillStatus.inProgress) {
          clearInterval(backfillPolling!);
          backfillPolling = null;
          await fetchSettings();
        }
      } catch { /* silent */ }
    }, 2000);
  }

  // ── History helpers ──────────────────────────────────────
  function toggle(idx: number) { expandedIdx = expandedIdx === idx ? null : idx; }

  function sourceBadgeStyle(source: string): { bg: string; label: string } {
    switch (source) {
      case "inject": return { bg: "bg-purple text-white", label: "inject" };
      case "cli": return { bg: "bg-primary text-white", label: "cli" };
      case "api": return { bg: "bg-success text-white", label: "api" };
      default: return { bg: "bg-dim text-white", label: source };
    }
  }

  export function fetchData() { fetchHistory(); }
</script>

<div class="flex items-center justify-between mb-6">
  <div>
    <h1 class="text-xl font-semibold mb-1">Search & Injection</h1>
    <p class="text-sm text-muted-foreground">Live search, history, algorithm comparison, and vector search settings</p>
  </div>
</div>

<Tabs.Root value="search" class="w-full">
  <Tabs.List class="mb-4">
    <Tabs.Trigger value="search">Live Search</Tabs.Trigger>
    <Tabs.Trigger value="history">History</Tabs.Trigger>
    <Tabs.Trigger value="settings">Settings</Tabs.Trigger>
  </Tabs.List>

  <!-- ═══════════════════ TAB 1: LIVE SEARCH ═══════════════════ -->
  <Tabs.Content value="search">
    <div class="space-y-4">
      <!-- Search input -->
      <div class="flex gap-2">
        <Input
          type="text"
          placeholder="Search memories..."
          value={searchQuery}
          oninput={onSearchInput}
          class="flex-1 font-mono"
        />
        <Button variant="outline" onclick={executeSearch} disabled={searchLoading || searchQuery.trim() === ""}>
          {searchLoading ? "Searching..." : "Search"}
        </Button>
      </div>

      {#if searchResults}
        <!-- Algorithm speed comparison -->
        {#if searchResults.algorithms.length > 0}
          <Card.Root class="p-4">
            <div class="flex items-center gap-3 mb-2">
              <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Algorithm Performance</h3>
              {#if searchResults.mergeStrategy === "rrf"}
                <span class="text-[10px] font-mono text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">RRF merged</span>
              {/if}
            </div>
            <SpeedComparisonBar
              algorithms={searchResults.algorithms.map((a) => ({
                name: a.algorithm === "fts5" ? "FTS5" : "Vector",
                durationMs: a.durationMs,
                color: a.algorithm === "fts5" ? "bg-primary" : "bg-purple",
              }))}
            />
          </Card.Root>
        {/if}

        <!-- View mode toggle -->
        {#if searchResults.algorithms.length > 1}
          <div class="flex gap-1">
            <Button
              variant={viewMode === "merged" ? "default" : "outline"}
              size="sm"
              onclick={() => (viewMode = "merged")}
            >Merged</Button>
            <Button
              variant={viewMode === "split" ? "default" : "outline"}
              size="sm"
              onclick={() => (viewMode = "split")}
            >Side by Side</Button>
          </div>
        {/if}

        <!-- Results -->
        {#if viewMode === "merged" || searchResults.algorithms.length <= 1}
          <!-- Merged view -->
          <Card.Root>
            <div class="p-3 px-4 border-b border-border">
              <h3 class="text-sm font-semibold">{searchResults.merged.length} Results</h3>
            </div>
            <div class="divide-y divide-border">
              {#if searchResults.merged.length === 0}
                <div class="p-6 text-center text-muted-foreground text-sm">No results found</div>
              {:else}
                {#each searchResults.merged as result}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="p-3 px-4 cursor-pointer hover:bg-muted/50 transition-colors"
                    onclick={() => (previewId = result.id)}
                  >
                    <div class="flex items-center gap-2 mb-1">
                      <span class="font-mono text-xs text-muted-foreground w-10">{result.score.toFixed(2)}</span>
                      <span class="text-sm font-medium text-primary">{result.title}</span>
                      <span class="text-[10px] font-mono text-dim">{result.scope}</span>
                      {#if result.algorithms}
                        {#each result.algorithms as algo}
                          <AlgorithmBadge algorithm={algo} />
                        {/each}
                      {/if}
                    </div>
                    <div class="text-xs text-muted-foreground ml-12 truncate">{result.excerpt}</div>
                  </div>
                {/each}
              {/if}
            </div>
          </Card.Root>
        {:else}
          <!-- Side by side view -->
          <div class="grid grid-cols-2 gap-4">
            {#each searchResults.algorithms as algo}
              <Card.Root>
                <div class="p-3 px-4 border-b border-border flex items-center gap-2">
                  <AlgorithmBadge algorithm={algo.algorithm} />
                  <span class="text-xs text-muted-foreground font-mono">{algo.durationMs}ms</span>
                  <span class="text-xs text-muted-foreground">{algo.results.length} results</span>
                </div>
                <div class="divide-y divide-border">
                  {#if algo.results.length === 0}
                    <div class="p-4 text-center text-muted-foreground text-xs">No results</div>
                  {:else}
                    {#each algo.results as result}
                      <!-- svelte-ignore a11y_click_events_have_key_events -->
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <div
                        class="p-2.5 px-3 cursor-pointer hover:bg-muted/50 transition-colors"
                        onclick={() => (previewId = result.id)}
                      >
                        <div class="flex items-center gap-2 mb-0.5">
                          <span class="font-mono text-[10px] text-muted-foreground">{result.score.toFixed(2)}</span>
                          <span class="text-xs font-medium text-primary truncate">{result.title}</span>
                        </div>
                        <div class="text-[10px] text-muted-foreground truncate">{result.excerpt}</div>
                      </div>
                    {/each}
                  {/if}
                </div>
              </Card.Root>
            {/each}
          </div>
        {/if}
      {:else if searchQuery.trim() === ""}
        <div class="text-center py-12 text-muted-foreground">
          <div class="text-[32px] mb-3 opacity-40">&#x1F50D;</div>
          <p class="text-sm">Type a query above to search your memories</p>
        </div>
      {/if}
    </div>
  </Tabs.Content>

  <!-- ═══════════════════ TAB 2: HISTORY ═══════════════════ -->
  <Tabs.Content value="history">
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
              <Table.Head>Vector</Table.Head>
              <Table.Head>Total</Table.Head>
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
                  <Table.Cell class="font-mono text-xs {r.resultCount > 0 ? 'text-success' : 'text-destructive'}">{r.resultCount}</Table.Cell>
                  <Table.Cell class="font-mono text-xs text-muted-foreground">{r.ftsDurationMs != null ? `${r.ftsDurationMs}ms` : "\u2014"}</Table.Cell>
                  <Table.Cell class="font-mono text-xs text-muted-foreground">{r.vectorDurationMs != null ? `${r.vectorDurationMs}ms` : "\u2014"}</Table.Cell>
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
  </Tabs.Content>

  <!-- ═══════════════════ TAB 3: SETTINGS ═══════════════════ -->
  <Tabs.Content value="settings">
    <div class="space-y-6">
      <!-- Stats overview -->
      <div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        {#if stats}
          <StatCard label="Total Queries" value={stats.totalQueries} />
          <StatCard label="Hit Rate" value="{hitRate}%" color={hitRate >= 80 ? "green" : hitRate >= 50 ? "yellow" : "red"} />
          <StatCard label="Avg Relevance" value={stats.avgScoreOfServed?.toFixed(2) ?? "\u2014"} />
        {/if}
        {#if vecSettings}
          <StatCard label="Vector Coverage" value="{vectorCoverage}%" color={vectorCoverage >= 80 ? "green" : vectorCoverage >= 50 ? "yellow" : "red"} sub="{vecSettings.embeddedCount}/{vecSettings.totalCount} entries" />
        {/if}
      </div>

      <!-- Vector Search Config -->
      <Card.Root>
        <div class="p-4 border-b border-border">
          <h3 class="text-sm font-semibold">Vector Search</h3>
          <p class="text-xs text-muted-foreground mt-1">Use OpenRouter.ai embeddings for semantic search alongside FTS5</p>
        </div>
        <div class="p-4 space-y-4">
          {#if vecSettings}
            <!-- Status indicator -->
            <div class="flex items-center gap-2">
              <div class="size-2.5 rounded-full {vecSettings.enabled ? 'bg-success' : 'bg-muted-foreground/30'}"></div>
              <span class="text-sm font-medium">{vecSettings.enabled ? "Enabled" : "Disabled"}</span>
              {#if vecSettings.enabled}
                <span class="text-xs text-muted-foreground">using {vecSettings.model}</span>
              {/if}
            </div>

            <!-- API Key -->
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground" for="api-key">OpenRouter API Key</label>
              <div class="flex gap-2">
                <Input
                  id="api-key"
                  type="password"
                  placeholder={vecSettings.hasApiKey ? "Key configured — enter new to replace" : "sk-or-v1-..."}
                  bind:value={apiKeyInput}
                  class="flex-1 font-mono text-xs"
                />
              </div>
              {#if vecSettings.hasApiKey}
                <p class="text-[10px] text-success font-mono">Key configured</p>
              {/if}
            </div>

            <!-- Actions -->
            <div class="flex gap-2">
              {#if !vecSettings.enabled || apiKeyInput !== ""}
                <Button size="sm" onclick={saveSettings} disabled={savingSettings}>
                  {savingSettings ? "Saving..." : vecSettings.enabled ? "Update Key" : "Enable & Save"}
                </Button>
              {/if}
              {#if vecSettings.enabled}
                <Button variant="outline" size="sm" onclick={disableVector} disabled={savingSettings}>
                  Disable
                </Button>
              {/if}
            </div>

            {#if settingsError}
              <p class="text-xs text-destructive">{settingsError}</p>
            {/if}
            {#if settingsSuccess}
              <p class="text-xs text-success">{settingsSuccess}</p>
            {/if}

            <!-- Embedding progress -->
            {#if vecSettings.enabled}
              <div class="border-t border-border pt-4 space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-medium text-muted-foreground">Embeddings</span>
                  <span class="font-mono text-xs text-muted-foreground">{vecSettings.embeddedCount} / {vecSettings.totalCount}</span>
                </div>
                <div class="w-full h-2 bg-muted/30 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-purple rounded-full transition-all duration-300"
                    style="width: {vecSettings.totalCount > 0 ? (vecSettings.embeddedCount / vecSettings.totalCount) * 100 : 0}%"
                  ></div>
                </div>
                {#if backfillStatus?.inProgress}
                  <p class="text-[10px] font-mono text-muted-foreground">
                    Backfilling... {backfillStatus.done}/{backfillStatus.total}
                    {#if backfillStatus.failed > 0}
                      ({backfillStatus.failed} failed)
                    {/if}
                  </p>
                {:else if vecSettings.embeddedCount < vecSettings.totalCount}
                  <Button variant="outline" size="sm" onclick={triggerBackfill}>
                    Backfill {vecSettings.totalCount - vecSettings.embeddedCount} Missing
                  </Button>
                {/if}
              </div>
            {/if}
          {:else}
            <div class="text-sm text-muted-foreground">Loading settings...</div>
          {/if}
        </div>
      </Card.Root>

      <!-- Source badge legend -->
      <Card.Root class="p-4">
        <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Search Sources</h3>
        <div class="text-xs text-muted-foreground flex flex-col gap-1">
          <div><span class="inline-block bg-purple text-white text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 min-w-[42px] text-center">inject</span> auto-injected into Claude on every message</div>
          <div><span class="inline-block bg-primary text-white text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 min-w-[42px] text-center">cli</span> manual <code>ctx-hive search</code> in terminal</div>
          <div><span class="inline-block bg-success text-white text-[10px] font-semibold font-mono rounded-full px-2 py-0.5 min-w-[42px] text-center">api</span> search via daemon REST API or dashboard</div>
        </div>
      </Card.Root>
    </div>
  </Tabs.Content>
</Tabs.Root>

<MemoryDetail memoryId={previewId} onClose={() => (previewId = null)} />
