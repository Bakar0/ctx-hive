<script lang="ts">
  import Badge from "../components/Badge.svelte";
  import StatCard from "../components/StatCard.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { timeAgo } from "../format/time";
  import * as api from "../api/client";
  import type { DiscoveredRepo } from "../api/types";

  let allRepos = $state<DiscoveredRepo[]>([]);
  let scanLoading = $state(false);
  let syncingRepos = $state(new Set<string>());
  let filter = $state("");

  $effect(() => { fetchRepos(); });

  export async function fetchRepos() {
    scanLoading = true;
    try {
      const [tracked, scanned] = await Promise.all([api.getRepos(), api.scanRepos()]);
      const trackedMap = new Map(tracked.map((r) => [r.absPath, r]));
      const merged = scanned.map((r) => trackedMap.get(r.absPath) ?? r);
      for (const t of tracked) { if (!scanned.find((s) => s.absPath === t.absPath)) merged.push(t); }
      merged.sort((a, b) => { if (a.tracked !== b.tracked) return a.tracked ? -1 : 1; return (b.lastModifiedAt ?? "").localeCompare(a.lastModifiedAt ?? ""); });
      allRepos = merged;
    } catch { /* silent */ } finally { scanLoading = false; }
  }

  let filtered = $derived.by(() => {
    if (filter === "") return allRepos;
    if (filter === "tracked") return allRepos.filter((r) => r.tracked);
    if (filter === "untracked") return allRepos.filter((r) => !r.tracked);
    return allRepos;
  });

  let trackedCount = $derived(allRepos.filter((r) => r.tracked).length);

  async function track(absPath: string) { try { await api.trackRepo(absPath); await fetchRepos(); } catch { /* silent */ } }
  async function untrack(absPath: string) { try { await api.untrackRepo(absPath); await fetchRepos(); } catch { /* silent */ } }
  async function sync(absPath: string) {
    syncingRepos = new Set([...syncingRepos, absPath]);
    try { await api.syncRepo(absPath); } catch { /* silent */ }
    syncingRepos = new Set([...syncingRepos].filter((p) => p !== absPath));
  }
  async function openIn(absPath: string, target: "vscode" | "terminal") { try { await api.openRepo(absPath, target); } catch { /* silent */ } }
</script>

<div class="flex justify-between items-center mb-6">
  <div>
    <h1 class="text-xl font-semibold mb-1">Repos</h1>
    <p class="text-sm text-muted-foreground">Manage tracked repositories</p>
  </div>
  <Button variant="outline" onclick={fetchRepos} class="flex items-center gap-1.5">
    {#if scanLoading}
      <span class="inline-block size-3.5 border-2 border-border border-t-primary rounded-full animate-spin"></span>
    {:else}
      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
    {/if}
    Refresh
  </Button>
</div>

<div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 mb-6">
  <StatCard label="Tracked" value={trackedCount} color="green" />
  <StatCard label="Discovered" value={allRepos.length} sub="{allRepos.length - trackedCount} untracked" />
</div>

<Card.Root>
  <div class="flex justify-between items-center p-3 px-4 border-b border-border">
    <h2 class="text-sm font-semibold">Repositories</h2>
    <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={filter}>
      <option value="">All repos</option>
      <option value="tracked">Tracked only</option>
      <option value="untracked">Untracked only</option>
    </select>
  </div>
  <div class="overflow-x-auto">
    <Table.Root>
      <Table.Header>
        <Table.Row><Table.Head>Name</Table.Head><Table.Head>Status</Table.Head><Table.Head>Contexts</Table.Head><Table.Head>Last Scanned</Table.Head><Table.Head></Table.Head></Table.Row>
      </Table.Header>
      <Table.Body>
        {#if filtered.length === 0}
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
              <Table.Cell class="font-mono text-xs text-muted-foreground">{r.contextCount}</Table.Cell>
              <Table.Cell class="font-mono text-xs text-muted-foreground">{timeAgo(r.lastScannedAt)}</Table.Cell>
              <Table.Cell>
                <div class="flex gap-1 items-center">
                  {#if r.tracked}
                    <Button variant="outline" size="sm" class="h-6 text-[11px] border-primary text-primary hover:bg-primary/10 {syncingRepos.has(r.absPath) ? 'opacity-50 pointer-events-none' : ''}" onclick={() => sync(r.absPath)}>
                      {syncingRepos.has(r.absPath) ? "Syncing..." : "Sync"}
                    </Button>
                  {/if}
                  <Button variant="ghost" size="sm" class="h-6 text-[11px] text-muted-foreground hover:text-foreground" onclick={() => openIn(r.absPath, "vscode")} title="Open in VS Code">code</Button>
                  <Button variant="ghost" size="sm" class="h-6 text-[11px] text-muted-foreground hover:text-foreground" onclick={() => openIn(r.absPath, "terminal")} title="Open in Terminal">term</Button>
                  {#if r.tracked}
                    <Button variant="ghost" size="sm" class="h-6 text-[11px] text-dim hover:text-destructive hover:border-destructive" onclick={() => untrack(r.absPath)}>Untrack</Button>
                  {:else}
                    <Button variant="outline" size="sm" class="h-6 text-[11px] border-success text-success hover:bg-success/10" onclick={() => track(r.absPath)}>Track</Button>
                  {/if}
                </div>
              </Table.Cell>
            </Table.Row>
          {/each}
        {/if}
      </Table.Body>
    </Table.Root>
  </div>
</Card.Root>

{#if allRepos.length === 0 && !scanLoading}
  <div class="text-center py-12 text-muted-foreground">
    <div class="text-[32px] mb-3 opacity-40">&#x1F4C2;</div>
    <p class="text-sm">No repositories found.</p>
  </div>
{/if}
