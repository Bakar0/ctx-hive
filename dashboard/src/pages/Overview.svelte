<script lang="ts">
  import StatCard from "../components/StatCard.svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Tabs from "$lib/components/ui/tabs/index.js";
  import LineChart from "../charts/LineChart.svelte";
  import BarChart from "../charts/BarChart.svelte";
  import { bucketByTime, type TimeWindow } from "../charts/time-bucket";
  import { formatCompact } from "../format/numbers";
  import * as api from "../api/client";
  import type { MetricsSnapshot, JobView, ContextEntry, SearchRecord } from "../api/types";

  let metrics = $state<MetricsSnapshot | null>(null);
  let overviewJobs = $state<JobView[]>([]);
  let overviewContexts = $state<ContextEntry[]>([]);
  let overviewSearchHistory = $state<SearchRecord[]>([]);
  let timeWindow = $state<TimeWindow>(
    (localStorage.getItem("ctx-hive-time-window") as TimeWindow) ?? "day",
  );

  interface Props {
    onWsMetrics?: (handler: (data: unknown) => void) => void;
  }

  let { onWsMetrics }: Props = $props();

  $effect(() => {
    fetchData();
    onWsMetrics?.((data) => {
      metrics = data as MetricsSnapshot;
    });
  });

  async function fetchData() {
    try {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const [m, j, c, s] = await Promise.all([
        api.getMetrics(),
        api.getJobs(),
        api.getContexts(),
        api.getSearchHistory({ since }),
      ]);
      metrics = m;
      overviewJobs = j;
      overviewContexts = c;
      overviewSearchHistory = s;
    } catch {
      // silent
    }
  }

  function setTimeWindow(w: string) {
    timeWindow = w as TimeWindow;
    localStorage.setItem("ctx-hive-time-window", w);
  }

  let totalInput = $derived(overviewJobs.reduce((s, j) => s + (j.inputTokens ?? 0), 0));
  let totalOutput = $derived(overviewJobs.reduce((s, j) => s + (j.outputTokens ?? 0), 0));
  let totalTokens = $derived(totalInput + totalOutput);

  let jobTimeSeries = $derived([{ name: "Jobs", color: "var(--primary)", data: bucketByTime(overviewJobs.map((j) => j.createdAt).filter(Boolean), timeWindow) }]);
  let contextTimeSeries = $derived([
    { name: "Created", color: "var(--success)", data: bucketByTime(overviewContexts.map((c) => c.created).filter(Boolean), timeWindow) },
    { name: "Updated", color: "var(--purple)", data: bucketByTime(overviewContexts.map((c) => c.updated).filter(Boolean), timeWindow) },
  ]);
  let searchTimeSeries = $derived([{ name: "Queries", color: "var(--purple)", data: bucketByTime(overviewSearchHistory.map((r) => r.timestamp).filter(Boolean), timeWindow) }]);

  let topProjects = $derived.by(() => {
    if (!metrics) return [];
    const colors = ["var(--primary)", "var(--purple)", "var(--success)", "var(--warning)", "var(--orange)", "var(--destructive)", "#58a6ff", "#bc8cff"];
    return Object.entries(metrics.contexts.byProject)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count], i) => ({ label: name, value: count, color: colors[i % colors.length]! }));
  });
</script>

<div class="flex justify-between items-start mb-6">
  <div>
    <h1 class="text-xl font-semibold mb-1">Dashboard</h1>
    <p class="text-sm text-muted-foreground">Live overview of your context hive</p>
  </div>
  <Tabs.Root value={timeWindow} onValueChange={setTimeWindow}>
    <Tabs.List class="h-8">
      <Tabs.Trigger value="day" class="text-xs px-3">Day</Tabs.Trigger>
      <Tabs.Trigger value="week" class="text-xs px-3">Week</Tabs.Trigger>
      <Tabs.Trigger value="month" class="text-xs px-3">Month</Tabs.Trigger>
    </Tabs.List>
  </Tabs.Root>
</div>

{#if metrics}
  <div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3 mb-6">
    <StatCard label="Total Contexts" value={metrics.contexts.total} color="accent" sub="{Object.keys(metrics.contexts.byProject).length} projects" />
    <StatCard label="Active Jobs" value={metrics.jobs.processing} color={metrics.jobs.processing > 0 ? "yellow" : ""} sub="{metrics.jobs.total} total" />
    <StatCard label="Search Queries" value={overviewSearchHistory.length} sub="last 30 days" />
    <StatCard label="Token Usage" value={formatCompact(totalTokens)} color="green" sub="{formatCompact(totalInput)} in / {formatCompact(totalOutput)} out" />
  </div>
{/if}

<div class="grid grid-cols-2 gap-4 mb-6 max-[900px]:grid-cols-1">
  <Card.Root class="p-4">
    <div class="text-xs text-muted-foreground uppercase tracking-wider mb-3">Job Activity</div>
    <LineChart series={jobTimeSeries} />
  </Card.Root>
  <Card.Root class="p-4">
    <div class="text-xs text-muted-foreground uppercase tracking-wider mb-3">
      Context Lifecycle
      <span class="flex gap-3 float-right -mt-0.5">
        <span class="text-[10px] flex items-center gap-1"><span class="size-2 rounded-full inline-block bg-success"></span> Created</span>
        <span class="text-[10px] flex items-center gap-1"><span class="size-2 rounded-full inline-block bg-purple"></span> Updated</span>
      </span>
    </div>
    <LineChart series={contextTimeSeries} />
  </Card.Root>
</div>

<div class="grid grid-cols-2 gap-4 mb-6 max-[900px]:grid-cols-1">
  <Card.Root class="p-4">
    <div class="text-xs text-muted-foreground uppercase tracking-wider mb-3">Search Volume</div>
    <LineChart series={searchTimeSeries} />
  </Card.Root>
  <Card.Root class="p-4">
    <div class="text-xs text-muted-foreground uppercase tracking-wider mb-3">Context Distribution by Project</div>
    <BarChart items={topProjects} />
  </Card.Root>
</div>
