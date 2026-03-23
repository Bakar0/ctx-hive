<script lang="ts">
  import Badge from "../components/Badge.svelte";
  import Pagination from "../components/Pagination.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { formatDuration, timeAgo } from "../format/time";
  import { formatCompact } from "../format/numbers";
  import * as api from "../api/client";
  import type { JobView } from "../api/types";

  interface Props {
    projects: string[];
  }

  let { projects }: Props = $props();

  let allJobs = $state<JobView[]>([]);
  let statusFilter = $state("");
  let projectFilter = $state("");
  let page = $state(1);
  let expandedIdx = $state<number | null>(null);
  const pageSize = 20;

  let filtered = $derived.by(() => {
    let list = allJobs;
    if (statusFilter !== "") list = list.filter((j) => j.status === statusFilter);
    if (projectFilter !== "") list = list.filter((j) => j.project === projectFilter);
    return list;
  });

  let totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  let pageItems = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));

  $effect(() => {
    fetchJobs();
  });

  export async function fetchJobs() {
    try {
      allJobs = await api.getJobs();
      expandedIdx = null;
    } catch { /* silent */ }
  }

  function toggle(idx: number) {
    expandedIdx = expandedIdx === idx ? null : idx;
  }

  async function rerun(filename: string) {
    try {
      await api.requeueJob(filename);
      await fetchJobs();
    } catch { /* silent */ }
  }

  function copySessionResume(sessionId: string) {
    navigator.clipboard.writeText(`claude --resume ${sessionId}`);
  }

  let now = $state(Date.now());
  $effect(() => {
    const interval = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(interval);
  });

  function elapsed(startedAt: string): string {
    return formatDuration(now - new Date(startedAt).getTime());
  }

  function homePath(cwd: string): string {
    return cwd.replace(/^\/Users\/[^/]+/, "~");
  }
</script>

<div class="mb-6">
  <h1 class="text-xl font-semibold mb-1">Jobs</h1>
  <p class="text-sm text-muted-foreground">Track all job executions across projects</p>
</div>

<div class="flex gap-2 items-center flex-wrap mb-4">
  <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={statusFilter} onchange={() => (page = 1)}>
    <option value="">All statuses</option>
    <option value="pending">Pending</option>
    <option value="processing">Processing</option>
    <option value="done">Done</option>
    <option value="failed">Failed</option>
  </select>
  <select class="h-8 rounded-md border border-input bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary" bind:value={projectFilter} onchange={() => (page = 1)}>
    <option value="">All projects</option>
    {#each projects as p}<option value={p}>{p}</option>{/each}
  </select>
</div>

<Card.Root>
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head class="w-8"></Table.Head>
        <Table.Head>Status</Table.Head>
        <Table.Head>Type</Table.Head>
        <Table.Head>Project</Table.Head>
        <Table.Head>Transcript</Table.Head>
        <Table.Head>Created</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#if filtered.length === 0}
        <Table.Row>
          <Table.Cell colspan={6} class="text-center text-muted-foreground py-8">No jobs found</Table.Cell>
        </Table.Row>
      {:else}
        {#each pageItems as j, i}
          {@const idx = (page - 1) * pageSize + i}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <Table.Row class="cursor-pointer {expandedIdx === idx ? 'bg-primary/4' : ''}" onclick={() => toggle(idx)}>
            <Table.Cell class="w-8 text-center">
              <span class="job-chevron" class:open={expandedIdx === idx}>&#x25B8;</span>
            </Table.Cell>
            <Table.Cell>
              <Badge variant={j.status} pulse={j.status === "processing"} />
              {#if j.status === "processing" && j.startedAt}
                <div class="font-mono animate-pulse text-dim text-[10px] mt-0.5">{elapsed(j.startedAt)}</div>
              {/if}
            </Table.Cell>
            <Table.Cell class="font-mono text-xs">
              {j.type || "\u2014"}
              {#if j.status === "done" && j.entriesCreated != null && j.entriesCreated > 0}
                <span class="text-success text-[11px]">+{j.entriesCreated}</span>
              {/if}
              {#if j.status === "failed"}
                <span class="text-destructive text-[11px]">&#x26A0;</span>
              {/if}
            </Table.Cell>
            <Table.Cell>{j.project || "\u2014"}</Table.Cell>
            <Table.Cell class="font-mono text-xs text-muted-foreground">
              {j.transcriptTokens != null ? formatCompact(j.transcriptTokens) + " tokens" : "\u2014"}
            </Table.Cell>
            <Table.Cell class="font-mono text-xs text-muted-foreground" title={j.createdAt ? new Date(j.createdAt).toLocaleString() : ""}>
              {timeAgo(j.createdAt)}
            </Table.Cell>
          </Table.Row>

          {#if expandedIdx === idx}
            <Table.Row class="hover:bg-transparent">
              <Table.Cell colspan={6} class="!p-0">
                <div class="p-4 pl-12 pb-5 bg-background border-t border-border">
                  <!-- Stats grid -->
                  <div class="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3 mb-4">
                    {#if j.status === "processing" && j.startedAt}
                      <div class="flex flex-col gap-0.5">
                        <div class="text-[10px] text-dim uppercase tracking-wider">Duration</div>
                        <div class="text-base font-semibold font-mono text-primary animate-pulse">{elapsed(j.startedAt)}</div>
                      </div>
                    {:else if j.duration_ms}
                      <div class="flex flex-col gap-0.5">
                        <div class="text-[10px] text-dim uppercase tracking-wider">Duration</div>
                        <div class="text-base font-semibold font-mono">{formatDuration(j.duration_ms)}</div>
                      </div>
                    {/if}
                    {#if j.entriesCreated != null}
                      <div class="flex flex-col gap-0.5">
                        <div class="text-[10px] text-dim uppercase tracking-wider">Entries Created</div>
                        <div class="text-base font-semibold font-mono {j.entriesCreated > 0 ? 'text-success' : 'text-dim'}">+{j.entriesCreated}</div>
                      </div>
                    {/if}
                    {#if j.transcriptTokens != null}
                      <div class="flex flex-col gap-0.5">
                        <div class="text-[10px] text-dim uppercase tracking-wider">Transcript Size</div>
                        <div class="text-base font-semibold font-mono">{formatCompact(j.transcriptTokens)} tokens</div>
                      </div>
                    {/if}
                    {#if j.inputTokens != null}
                      <div class="flex flex-col gap-0.5">
                        <div class="text-[10px] text-dim uppercase tracking-wider">Input Tokens</div>
                        <div class="text-base font-semibold font-mono text-primary">{formatCompact(j.inputTokens)}</div>
                      </div>
                    {/if}
                    {#if j.outputTokens != null}
                      <div class="flex flex-col gap-0.5">
                        <div class="text-[10px] text-dim uppercase tracking-wider">Output Tokens</div>
                        <div class="text-base font-semibold font-mono text-purple">{formatCompact(j.outputTokens)}</div>
                      </div>
                    {/if}
                  </div>

                  {#if j.inputTokens != null && j.outputTokens != null}
                    {@const total = j.inputTokens + j.outputTokens}
                    {@const inputPct = total > 0 ? ((j.inputTokens / total) * 100).toFixed(1) : "50.0"}
                    {@const outputPct = total > 0 ? ((j.outputTokens / total) * 100).toFixed(1) : "50.0"}
                    <div class="flex items-center gap-2 mt-3">
                      <span class="font-mono text-[11px] text-primary">input {inputPct}%</span>
                      <div class="flex-1 h-2 bg-muted rounded overflow-hidden flex">
                        <div class="h-full bg-primary rounded-l" style="width:{inputPct}%"></div>
                        <div class="h-full bg-purple" style="width:{outputPct}%"></div>
                      </div>
                      <span class="font-mono text-[11px] text-purple">output {outputPct}%</span>
                    </div>
                  {/if}

                  {#if j.sessionId}
                    <div class="flex items-center gap-2 font-mono text-xs text-muted-foreground mt-3 p-2 px-3 bg-card rounded-md">
                      <span class="text-dim">Session:</span>
                      <code class="text-primary">{j.sessionId}</code>
                      <Button variant="outline" size="sm" class="h-6 text-[11px]" onclick={(e: MouseEvent) => { e.stopPropagation(); copySessionResume(j.sessionId!); }}>&#x2398; Resume</Button>
                    </div>
                  {/if}

                  {#if j.cwd}
                    <div class="font-mono text-[11px] text-dim break-all mt-2">
                      <span class="text-dim">Working directory:</span> {homePath(j.cwd)}
                    </div>
                  {/if}

                  {#if j.reason}
                    <div class="mt-2 text-xs text-muted-foreground">
                      <span class="text-dim">Reason:</span> {j.reason}
                    </div>
                  {/if}

                  <div class="flex gap-4 flex-wrap mt-3 text-[11px] text-dim">
                    {#if j.createdAt}<span class="font-mono">Created: {new Date(j.createdAt).toLocaleString()}</span>{/if}
                    {#if j.startedAt}<span class="font-mono">Started: {new Date(j.startedAt).toLocaleString()}</span>{/if}
                    {#if j.completedAt}<span class="font-mono">Completed: {new Date(j.completedAt).toLocaleString()}</span>{/if}
                    {#if j.failedAt}<span class="font-mono">Failed: {new Date(j.failedAt).toLocaleString()}</span>{/if}
                  </div>

                  {#if j.status === "failed" && j.error}
                    <div class="bg-destructive/8 border border-destructive/25 rounded-md p-3 mt-3">
                      <div class="text-[10px] text-destructive uppercase tracking-wider mb-1">Error</div>
                      <div class="text-xs text-destructive font-mono break-words whitespace-pre-wrap leading-relaxed">{j.error}</div>
                    </div>
                    <div class="mt-2">
                      <Button variant="outline" size="sm" class="h-7 text-[11px]" onclick={(e: MouseEvent) => { e.stopPropagation(); rerun(j.filename); }}>&#x21bb; Rerun</Button>
                    </div>
                  {/if}

                  {#if j.filename}
                    <div class="mt-3 text-[10px] text-dim font-mono">File: {j.filename}</div>
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
