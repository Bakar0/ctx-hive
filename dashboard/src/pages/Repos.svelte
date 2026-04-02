<script lang="ts">
  import Badge from "../components/Badge.svelte";
  import StatCard from "../components/StatCard.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { timeAgo } from "../format/time";
  import { repoStore } from "../state/repos.svelte.ts";
  import type { BranchWatch } from "../api/types";
  import * as api from "../api/client.ts";

  $effect(() => { if (repoStore.repos === null) repoStore.refresh(); });

  let filtered = $derived.by(() => {
    const all = repoStore.repos ?? [];
    if (repoStore.filter === "") return all;
    if (repoStore.filter === "tracked") return all.filter((r) => r.tracked);
    if (repoStore.filter === "untracked") return all.filter((r) => !r.tracked);
    return all;
  });

  let trackedCount = $derived((repoStore.repos ?? []).filter((r) => r.tracked).length);

  // Branch management state
  let expandedRepo = $state<string | null>(null);
  let branchData = $state<{ watched: BranchWatch[]; available: string[] } | null>(null);
  let loadingBranches = $state(false);
  let addingBranch = $state<string | null>(null);

  async function toggleBranches(absPath: string) {
    if (expandedRepo === absPath) {
      expandedRepo = null;
      branchData = null;
      return;
    }
    expandedRepo = absPath;
    loadingBranches = true;
    try {
      branchData = await api.getRepoBranches(absPath);
    } catch {
      branchData = null;
    }
    loadingBranches = false;
  }

  async function handleWatchBranch(absPath: string, branch: string) {
    addingBranch = branch;
    try {
      await api.watchBranch(absPath, branch);
      branchData = await api.getRepoBranches(absPath);
    } catch { /* silent */ }
    addingBranch = null;
  }

  async function handleUnwatchBranch(absPath: string, branch: string) {
    try {
      await api.unwatchBranch(absPath, branch);
      branchData = await api.getRepoBranches(absPath);
    } catch { /* silent */ }
  }
</script>

<div class="flex justify-between items-center mb-6">
  <div>
    <h1 class="text-xl font-semibold mb-1">Repos</h1>
    <p class="text-sm text-muted-foreground">Manage tracked repositories</p>
  </div>
  <Button variant="outline" onclick={() => repoStore.refresh()} class="flex items-center gap-1.5">
    {#if repoStore.refreshing}
      <span class="inline-block size-3.5 border-2 border-border border-t-primary rounded-full animate-spin"></span>
    {:else}
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
    {/if}
    Refresh
  </Button>
</div>

<div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 mb-6">
  <StatCard label="Tracked" value={trackedCount} color="green" />
  <StatCard label="Discovered" value={(repoStore.repos ?? []).length} sub="{(repoStore.repos ?? []).length - trackedCount} untracked" />
</div>

<Card.Root>
  <div class="flex justify-between items-center p-3 px-4 border-b border-border">
    <h2 class="text-sm font-semibold">Repositories</h2>
    <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={repoStore.filter}>
      <option value="">All repos</option>
      <option value="tracked">Tracked only</option>
      <option value="untracked">Untracked only</option>
    </select>
  </div>
  <div class="overflow-x-auto">
    <Table.Root>
      <Table.Header>
        <Table.Row><Table.Head>Name</Table.Head><Table.Head>Status</Table.Head><Table.Head>Memories</Table.Head><Table.Head>Last Scanned</Table.Head><Table.Head></Table.Head></Table.Row>
      </Table.Header>
      <Table.Body>
        {#if repoStore.initialLoading}
          {#each {length: 5} as _}
            <Table.Row>
              <Table.Cell>
                <div class="space-y-2">
                  <div class="h-4 w-32 bg-muted rounded animate-pulse"></div>
                  <div class="h-3 w-48 bg-muted rounded animate-pulse"></div>
                  <div class="h-3 w-20 bg-muted rounded animate-pulse"></div>
                </div>
              </Table.Cell>
              <Table.Cell><div class="h-5 w-16 bg-muted rounded-full animate-pulse"></div></Table.Cell>
              <Table.Cell><div class="h-4 w-6 bg-muted rounded animate-pulse"></div></Table.Cell>
              <Table.Cell><div class="h-4 w-14 bg-muted rounded animate-pulse"></div></Table.Cell>
              <Table.Cell><div class="h-6 w-24 bg-muted rounded animate-pulse"></div></Table.Cell>
            </Table.Row>
          {/each}
        {:else if filtered.length === 0}
          <Table.Row><Table.Cell colspan={5} class="text-center text-muted-foreground py-8">No repositories found</Table.Cell></Table.Row>
        {:else}
          {#each filtered as r}
            {@const isClean = r.modifiedCount === 0 && r.untrackedCount === 0 && r.behindCount === 0}
            <Table.Row>
              <Table.Cell>
                <div class="font-medium">{r.name}</div>
                <div class="font-mono text-[11px] text-dim truncate max-w-[350px]">{r.absPath}</div>
                <div class="flex items-center gap-2 mt-1 font-mono text-[11px]">
                  <span class="flex items-center gap-1 text-muted-foreground">
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>
                    {r.currentBranch}
                  </span>
                  {#if isClean}
                    <span class="text-muted-foreground" title="Clean working tree">&#x2713;</span>
                  {:else}
                    {#if r.modifiedCount > 0}
                      <span class="text-muted-foreground" title="{r.modifiedCount} modified">!{r.modifiedCount}</span>
                    {/if}
                    {#if r.untrackedCount > 0}
                      <span class="text-muted-foreground" title="{r.untrackedCount} untracked">?{r.untrackedCount}</span>
                    {/if}
                    {#if r.behindCount > 0}
                      <span class="text-muted-foreground" title="{r.behindCount} commits behind">&darr;{r.behindCount}</span>
                    {/if}
                  {/if}
                </div>
              </Table.Cell>
              <Table.Cell>
                {#if !r.exists}<Badge variant="missing" />
                {:else if r.tracked}<Badge variant="tracked" />
                {:else}<Badge variant="untracked" />{/if}
              </Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground">{r.memoryCount}</Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground">{timeAgo(r.lastScannedAt)}</Table.Cell>
              <Table.Cell>
                <div class="flex gap-1 items-center">
                  {#if r.tracked}
                    <Button variant="outline" size="sm" class="h-6 text-[11px] border-primary text-primary hover:bg-primary/10 {repoStore.syncingRepos.has(r.absPath) ? 'opacity-50 pointer-events-none' : ''}" onclick={() => repoStore.sync(r.absPath)}>
                      {repoStore.syncingRepos.has(r.absPath) ? "Checking..." : "Refresh"}
                    </Button>
                    <Button variant="ghost" size="sm" class="h-6 text-[11px] text-muted-foreground hover:text-foreground" onclick={() => toggleBranches(r.absPath)} title="Manage watched branches">
                      {expandedRepo === r.absPath ? "▾" : "▸"} branches
                    </Button>
                  {/if}
                  <Button variant="ghost" size="sm" class="h-6 text-[11px] text-muted-foreground hover:text-foreground" onclick={() => repoStore.openIn(r.absPath, "vscode")} title="Open in VS Code">code</Button>
                  <Button variant="ghost" size="sm" class="h-6 text-[11px] text-muted-foreground hover:text-foreground" onclick={() => repoStore.openIn(r.absPath, "terminal")} title="Open in Terminal">term</Button>
                  {#if r.tracked}
                    <Button variant="ghost" size="sm" class="h-6 text-[11px] text-dim hover:text-destructive hover:border-destructive" onclick={() => repoStore.untrack(r.absPath)}>Untrack</Button>
                  {:else}
                    <Button variant="outline" size="sm" class="h-6 text-[11px] border-success text-success hover:bg-success/10" onclick={() => repoStore.track(r.absPath)}>Track</Button>
                  {/if}
                </div>
              </Table.Cell>
            </Table.Row>
            {#if expandedRepo === r.absPath}
              <Table.Row>
                <Table.Cell colspan={5} class="bg-muted/30 px-6 py-3">
                  {#if loadingBranches}
                    <div class="text-xs text-muted-foreground">Loading branches...</div>
                  {:else if branchData}
                    <div class="space-y-2">
                      <div class="text-xs font-medium text-muted-foreground">Watched branches</div>
                      <div class="flex flex-wrap gap-1.5">
                        {#each branchData.watched as w}
                          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono bg-primary/10 text-primary border border-primary/20">
                            {w.branchName}
                            {#if w.isDefault}
                              <span class="text-[9px] opacity-60">(default)</span>
                            {/if}
                            {#if !w.isDefault}
                              <button class="ml-0.5 opacity-50 hover:opacity-100" onclick={() => handleUnwatchBranch(r.absPath, w.branchName)} title="Stop watching">&times;</button>
                            {/if}
                          </span>
                        {/each}
                      </div>
                      {#if branchData.available.length > 0}
                        <div class="text-xs font-medium text-muted-foreground mt-2">Add branch</div>
                        <div class="flex flex-wrap gap-1.5">
                          {#each branchData.available as branch}
                            <button
                              class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono bg-muted text-muted-foreground border border-border hover:border-primary hover:text-primary transition-colors {addingBranch === branch ? 'opacity-50' : ''}"
                              onclick={() => handleWatchBranch(r.absPath, branch)}
                              disabled={addingBranch === branch}
                            >
                              + {branch}
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {:else}
                    <div class="text-xs text-muted-foreground">Failed to load branches</div>
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
        {/if}
      </Table.Body>
    </Table.Root>
  </div>
</Card.Root>

{#if repoStore.repos !== null && repoStore.repos.length === 0 && !repoStore.fetching}
  <div class="text-center py-12 text-muted-foreground">
    <div class="text-[32px] mb-3 opacity-40">&#x1F4C2;</div>
    <p class="text-sm">No repositories found.</p>
  </div>
{/if}
