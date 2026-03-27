import type {
  MetricsSnapshot,
  JobView,
  ContextEntry,
  SignalsStore,
  DiscoveredRepo,
  SearchRecord,
  SearchStats,
  SessionSummary,
  TrackedRepo,
  PipelineExecution,
  PipelineStats,
  MultiSearchResponse,
  VectorSearchSettings,
  BackfillStatus,
} from "./types";

const BASE = "";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  return res.json() as Promise<T>;
}

// ── Metrics & Jobs ───────────────────────────────────────────────────

export function getMetrics(): Promise<MetricsSnapshot> {
  return get("/api/metrics");
}

export function getJobs(): Promise<JobView[]> {
  return get("/api/jobs");
}

export function requeueJob(filename: string): Promise<{ ok: boolean }> {
  return post(`/api/jobs/${encodeURIComponent(filename)}/requeue`);
}

// ── Contexts ─────────────────────────────────────────────────────────

export function getContexts(params?: {
  scope?: string;
  project?: string;
  sortBy?: "time" | "project";
}): Promise<ContextEntry[]> {
  const sp = new URLSearchParams();
  if (params?.scope != null && params.scope !== "") sp.set("scope", params.scope);
  if (params?.project != null && params.project !== "") sp.set("project", params.project);
  if (params?.sortBy != null && params.sortBy !== "") sp.set("sortBy", params.sortBy);
  const qs = sp.toString();
  return get(`/api/contexts${qs !== "" ? `?${qs}` : ""}`);
}

export function deleteContext(id: string): Promise<{ ok: boolean }> {
  return del(`/api/contexts/${encodeURIComponent(id)}`);
}

export function getProjects(): Promise<string[]> {
  return get("/api/projects");
}

// ── Signals ──────────────────────────────────────────────────────────

export function getSignals(): Promise<SignalsStore> {
  return get("/api/signals");
}

// ── Search ───────────────────────────────────────────────────────────

export function getSearchHistory(params?: {
  since?: string;
  limit?: number;
}): Promise<SearchRecord[]> {
  const sp = new URLSearchParams();
  if (params?.since != null && params.since !== "") sp.set("since", params.since);
  if (params?.limit != null) sp.set("limit", String(params.limit));
  const qs = sp.toString();
  return get(`/api/search-history${qs !== "" ? `?${qs}` : ""}`);
}

export function getSearchStats(): Promise<SearchStats> {
  return get("/api/search-stats");
}

export function searchEntries(params: {
  q: string;
  scope?: string;
  project?: string;
  tags?: string;
  limit?: number;
  mode?: "merged" | "full";
}): Promise<MultiSearchResponse> {
  const sp = new URLSearchParams();
  sp.set("q", params.q);
  sp.set("mode", params.mode ?? "full");
  sp.set("source", "api");
  if (params.scope != null && params.scope !== "") sp.set("scope", params.scope);
  if (params.project != null && params.project !== "") sp.set("project", params.project);
  if (params.tags != null && params.tags !== "") sp.set("tags", params.tags);
  if (params.limit != null) sp.set("limit", String(params.limit));
  return get(`/api/search?${sp.toString()}`);
}

// ── Vector search settings ──────────────────────────────────────────

export function getVectorSearchSettings(): Promise<VectorSearchSettings> {
  return get("/api/settings/vector-search");
}

export function updateVectorSearchSettings(settings: {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
}): Promise<{ ok: boolean; backfillStarted?: boolean; error?: string }> {
  return post("/api/settings/vector-search", settings);
}

export function triggerBackfill(): Promise<{ ok: boolean }> {
  return post("/api/settings/vector-search/backfill");
}

export function getBackfillStatus(): Promise<BackfillStatus> {
  return get("/api/settings/vector-search/status");
}

// ── Sessions ────────────────────────────────────────────────────────

export function getSessions(params?: {
  project?: string;
  since?: string;
  limit?: number;
}): Promise<SessionSummary[]> {
  const sp = new URLSearchParams();
  if (params?.project != null && params.project !== "") sp.set("project", params.project);
  if (params?.since != null && params.since !== "") sp.set("since", params.since);
  if (params?.limit != null) sp.set("limit", String(params.limit));
  const qs = sp.toString();
  return get(`/api/sessions${qs !== "" ? `?${qs}` : ""}`);
}

// ── Repos ────────────────────────────────────────────────────────────

export function getRepos(): Promise<DiscoveredRepo[]> {
  return get("/api/repos");
}

export function scanRepos(root = "~/", depth = 4): Promise<DiscoveredRepo[]> {
  return get(`/api/repos/scan?root=${encodeURIComponent(root)}&depth=${depth}`);
}

export function trackRepo(absPath: string): Promise<TrackedRepo> {
  return post("/api/repos/track", { absPath });
}

export function untrackRepo(absPath: string): Promise<{ ok: boolean }> {
  return post("/api/repos/untrack", { absPath });
}

export function syncRepo(absPath: string): Promise<{ ok: boolean }> {
  return post("/api/repos/sync", { absPath });
}

export function openRepo(
  absPath: string,
  target: "vscode" | "terminal",
): Promise<{ ok: boolean }> {
  return post("/api/repos/open", { absPath, target });
}

// ── Pipelines ───────────────────────────────────────────────────────

export function getPipelines(params?: {
  project?: string;
  status?: string;
  limit?: number;
}): Promise<PipelineExecution[]> {
  const sp = new URLSearchParams();
  if (params?.project != null && params.project !== "") sp.set("project", params.project);
  if (params?.status != null && params.status !== "") sp.set("status", params.status);
  if (params?.limit != null) sp.set("limit", String(params.limit));
  const qs = sp.toString();
  return get(`/api/pipelines${qs !== "" ? `?${qs}` : ""}`);
}

export function getPipeline(executionId: string): Promise<PipelineExecution> {
  return get(`/api/pipelines/${encodeURIComponent(executionId)}`);
}

export function getPipelineStats(): Promise<PipelineStats> {
  return get("/api/pipeline-stats");
}

export function getStageMessage(executionId: string, stageName: string): Promise<unknown> {
  return get(`/api/pipelines/${encodeURIComponent(executionId)}/messages/${encodeURIComponent(stageName)}`);
}
