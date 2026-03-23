import type {
  MetricsSnapshot,
  JobView,
  ContextEntry,
  SignalsStore,
  DiscoveredRepo,
  SearchRecord,
  SearchStats,
  TrackedRepo,
} from "./types";

const BASE = "";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
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
