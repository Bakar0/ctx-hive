/**
 * REST API endpoints for the ctx-hive dashboard.
 * Provides read access to jobs, contexts, pipelines, and metrics.
 */
import { join, basename } from "node:path";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  loadIndex,
  deleteEntry,
  resolveEntry,
  hiveRoot,
  parseFrontmatter,
  type IndexEntry,
  isScope,
  SCOPES,
} from "../ctx/store.ts";
import {
  PENDING_DIR,
  PROCESSING_DIR,
  DONE_DIR,
  FAILED_DIR,
  listJobs,
  RawJobFileSchema,
  enqueueRepoSync,
  type JobStatus,
} from "./jobs.ts";
import {
  trackRepo,
  untrackRepo,
  updateLastScanned,
} from "../repo/tracking.ts";
import { loadSignals } from "../ctx/signals.ts";
import { search, type SearchFilters } from "../ctx/search.ts";
import { loadSearchHistory, getSearchStats, type SearchSource } from "../ctx/search-history.ts";
import {
  discoverRepos,
  enrichTrackedRepos,
} from "../repo/scanner.ts";
import { broadcastRepoEvent } from "./ws.ts";
import { errorMessage } from "../git/run.ts";
import { listExecutionIds, readManifest, readMessage, canonicalStageName } from "../pipeline/messages.ts";
import { PipelineExecutionSchema, type PipelineExecution } from "../pipeline/schema.ts";

// ── Types ─────────────────────────────────────────────────────────────

export interface JobView {
  filename: string;
  status: JobStatus;
  type: string;
  createdAt: string;
  sessionId?: string;
  cwd?: string;
  project?: string;
  reason?: string;
  error?: string;
  failedAt?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  transcriptTokens?: number;
  entriesCreated?: number;
  inputTokens?: number;
  outputTokens?: number;
  pipeline?: unknown;
}

export interface MetricsSnapshot {
  timestamp: string;
  jobs: {
    pending: number;
    processing: number;
    done: number;
    failed: number;
    total: number;
  };
  contexts: {
    total: number;
    byScope: Record<string, number>;
    byProject: Record<string, number>;
  };
  recentJobs: JobView[];
}

// ── Helpers ───────────────────────────────────────────────────────────

function openInTerminal(absPath: string): void {
  const term = process.env.TERM_PROGRAM ?? "";
  switch (term) {
    case "iTerm.app":
      Bun.spawn(["open", "-a", "iTerm", absPath]);
      break;
    case "WarpTerminal":
      Bun.spawn(["open", "-a", "Warp", absPath]);
      break;
    case "Hyper":
      Bun.spawn(["open", "-a", "Hyper", absPath]);
      break;
    case "kitty":
      Bun.spawn(["kitty", "--single-instance", "--directory", absPath]);
      break;
    case "Alacritty":
      Bun.spawn(["alacritty", "--working-directory", absPath]);
      break;
    case "WezTerm":
      Bun.spawn(["wezterm", "start", "--cwd", absPath]);
      break;
    default:
      Bun.spawn(["open", "-a", "Terminal", absPath]);
  }
}

function projectFromCwd(cwd?: string): string {
  if (cwd === undefined || cwd === "") return "unknown";
  return basename(cwd);
}

const RepoBodySchema = z.object({ absPath: z.string().min(1) });
const RepoOpenBodySchema = z.object({ absPath: z.string().min(1), target: z.string().optional() });

async function loadJobsFromDir(
  dir: string,
  status: JobView["status"]
): Promise<JobView[]> {
  const paths = await listJobs(dir);
  const results = await Promise.all(
    paths.map(async (p): Promise<JobView | null> => {
      try {
        const raw = await Bun.file(p).text();
        const data = RawJobFileSchema.parse(JSON.parse(raw));
        return {
          filename: basename(p),
          status,
          type: data.type ?? "unknown",
          createdAt: data.createdAt ?? "",
          sessionId: data.sessionId,
          cwd: data.cwd,
          project: projectFromCwd(data.cwd ?? data.repoPath),
          reason: data.reason,
          error: data.error,
          failedAt: data.failedAt,
          startedAt: data.startedAt,
          completedAt: data.completedAt,
          durationMs: data.durationMs,
          transcriptTokens: data.transcriptTokens,
          entriesCreated: data.entriesCreated,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          pipeline: data.pipeline,
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((j): j is JobView => j !== null);
}

// ── API Functions ─────────────────────────────────────────────────────

export async function getAllJobs(): Promise<JobView[]> {
  const [pending, processing, done, failed] = await Promise.all([
    loadJobsFromDir(PENDING_DIR, "pending"),
    loadJobsFromDir(PROCESSING_DIR, "processing"),
    loadJobsFromDir(DONE_DIR, "done"),
    loadJobsFromDir(FAILED_DIR, "failed"),
  ]);
  const all = [...processing, ...pending, ...done, ...failed];
  // Sort by createdAt descending
  all.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return all;
}

export async function getContexts(params: {
  scope?: string;
  project?: string;
  sortBy?: "time" | "project";
}): Promise<(IndexEntry & { body: string })[]> {
  const index = await loadIndex();
  let entries = [...index];

  if (params.scope != null && params.scope !== "" && (SCOPES as readonly string[]).includes(params.scope)) {
    entries = entries.filter((e) => e.scope === params.scope);
  }
  if (params.project != null && params.project !== "") {
    entries = entries.filter((e) => e.project === params.project);
  }

  // Load bodies
  const root = hiveRoot();
  const full = await Promise.all(
    entries.map(async (e) => {
      try {
        const raw = await Bun.file(join(root, e.path)).text();
        const { body } = parseFrontmatter(raw);
        return { ...e, body };
      } catch {
        return { ...e, body: "" };
      }
    })
  );

  if (params.sortBy === "project") {
    full.sort((a, b) => a.project.localeCompare(b.project) || b.updated.localeCompare(a.updated));
  } else {
    // default: sort by time (updated) descending
    full.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  return full;
}

export async function getMetrics(): Promise<MetricsSnapshot> {
  const [allJobs, index] = await Promise.all([getAllJobs(), loadIndex()]);

  const counts = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const j of allJobs) {
    counts[j.status]++;
  }

  const byScope: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  for (const e of index) {
    byScope[e.scope] = (byScope[e.scope] ?? 0) + 1;
    if (e.project) {
      byProject[e.project] = (byProject[e.project] ?? 0) + 1;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    jobs: { ...counts, total: allJobs.length },
    contexts: { total: index.length, byScope, byProject },
    recentJobs: allJobs.slice(0, 20),
  };
}

export async function deleteContextById(idOrSlug: string): Promise<boolean> {
  const resolved = await resolveEntry(idOrSlug);
  if (!resolved) return false;
  await deleteEntry(resolved.scope, resolved.slug);
  return true;
}

// ── Session summaries ────────────────────────────────────────────────

export interface SessionServedEntry {
  id: string;
  title: string;
  maxScore: number;
  rating?: -1 | 0 | 1 | 2;
  reason?: string;
}

export interface SessionSummary {
  sessionId: string;
  project: string;
  firstSeen: string;
  lastSeen: string;
  injectionCount: number;
  servedEntries: SessionServedEntry[];
  evaluationComplete: boolean;
}

export async function getSessionSummaries(opts?: {
  project?: string;
  since?: Date;
  limit?: number;
}): Promise<SessionSummary[]> {
  const records = await loadSearchHistory();
  const signals = await loadSignals();

  // Group inject records by sessionId
  const sessionMap = new Map<string, {
    project: string;
    firstSeen: string;
    lastSeen: string;
    injectionCount: number;
    entries: Map<string, { id: string; title: string; maxScore: number }>;
  }>();

  for (const r of records) {
    if (r.source !== "inject" || r.sessionId === undefined || r.sessionId === "") continue;
    if (opts?.since !== undefined && new Date(r.timestamp).getTime() < opts.since.getTime()) continue;
    if (opts?.project !== undefined && r.project !== opts.project) continue;

    let session = sessionMap.get(r.sessionId);
    if (session === undefined) {
      session = {
        project: r.project ?? "unknown",
        firstSeen: r.timestamp,
        lastSeen: r.timestamp,
        injectionCount: 0,
        entries: new Map(),
      };
      sessionMap.set(r.sessionId, session);
    }

    session.injectionCount++;
    if (r.timestamp < session.firstSeen) session.firstSeen = r.timestamp;
    if (r.timestamp > session.lastSeen) session.lastSeen = r.timestamp;

    for (const result of r.results) {
      const existing = session.entries.get(result.id);
      if (existing === undefined || result.score > existing.maxScore) {
        session.entries.set(result.id, { id: result.id, title: result.title, maxScore: result.score });
      }
    }
  }

  // Build summaries with evaluation data from signals
  const summaries: SessionSummary[] = [];

  for (const [sessionId, session] of sessionMap) {
    const servedEntries: SessionServedEntry[] = [];
    let allEvaluated = true;

    for (const entry of session.entries.values()) {
      const entrySignals = signals.entries[entry.id];
      const evaluation = entrySignals?.evaluations.find((ev) => ev.sessionId === sessionId);
      if (evaluation === undefined) allEvaluated = false;

      servedEntries.push({
        id: entry.id,
        title: entry.title,
        maxScore: entry.maxScore,
        rating: evaluation?.rating,
        reason: evaluation?.reason,
      });
    }

    summaries.push({
      sessionId,
      project: session.project,
      firstSeen: session.firstSeen,
      lastSeen: session.lastSeen,
      injectionCount: session.injectionCount,
      servedEntries,
      evaluationComplete: servedEntries.length > 0 && allEvaluated,
    });
  }

  // Sort by lastSeen descending (newest first)
  summaries.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  if (opts?.limit !== undefined && opts.limit > 0) {
    return summaries.slice(0, opts.limit);
  }

  return summaries;
}

// ── Router ────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function handleApiRequest(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // GET /api/metrics
  if (path === "/api/metrics" && req.method === "GET") {
    return json(await getMetrics());
  }

  // GET /api/jobs
  if (path === "/api/jobs" && req.method === "GET") {
    return json(await getAllJobs());
  }

  // POST /api/jobs/:filename/requeue
  const requeueMatch = /^\/api\/jobs\/(.+)\/requeue$/.exec(path);
  if (requeueMatch && req.method === "POST") {
    const filename = decodeURIComponent(requeueMatch[1]!);
    const failedPath = join(FAILED_DIR, filename);
    const file = Bun.file(failedPath);
    if (!(await file.exists())) return json({ error: "Job not found in failed/" }, 404);
    const data: Record<string, unknown> = RawJobFileSchema.passthrough().parse(JSON.parse(await file.text()));
    // Strip processing metadata so the job is treated as fresh
    for (const key of ["error", "failedAt", "startedAt", "completedAt", "durationMs", "entriesCreated", "inputTokens", "outputTokens", "transcriptTokens", "pipeline"]) {
      delete data[key];
    }
    await Bun.write(join(PENDING_DIR, filename), JSON.stringify(data, null, 2));
    await unlink(failedPath);
    return json({ ok: true });
  }

  // GET /api/contexts?scope=...&project=...&sortBy=time|project
  if (path === "/api/contexts" && req.method === "GET") {
    const scope = url.searchParams.get("scope") ?? undefined;
    const project = url.searchParams.get("project") ?? undefined;
    const sortByParam = url.searchParams.get("sortBy");
    const sortBy = sortByParam === "project" ? "project" : "time";
    return json(await getContexts({ scope, project, sortBy }));
  }

  // DELETE /api/contexts/:id
  const deleteMatch = /^\/api\/contexts\/(.+)$/.exec(path);
  if (deleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(deleteMatch[1]!);
    const deleted = await deleteContextById(id);
    if (deleted) return json({ ok: true });
    return json({ error: "Not found" }, 404);
  }

  // GET /api/projects — unique project list
  if (path === "/api/projects" && req.method === "GET") {
    const index = await loadIndex();
    const projects = [...new Set(index.map((e) => e.project).filter(Boolean))].sort();
    return json(projects);
  }

  // GET /api/signals
  if (path === "/api/signals" && req.method === "GET") {
    return json(await loadSignals());
  }

  // ── Search endpoints ──────────────────────────────────────────────────

  // GET /api/search?q=...&scope=...&project=...&tags=...&limit=...
  if (path === "/api/search" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    if (q === "") return json({ error: "q parameter required" }, 400);
    const scope = url.searchParams.get("scope") ?? undefined;
    const project = url.searchParams.get("project") ?? undefined;
    const tagsParam = url.searchParams.get("tags");
    const tags = tagsParam !== null && tagsParam !== "" ? tagsParam.split(",").filter(Boolean) : undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "5", 10);
    const validScope = scope !== undefined && isScope(scope) ? scope : undefined;
    const filters: SearchFilters = { scope: validScope, tags, project };
    const rawSource = url.searchParams.get("source");
    const source: SearchSource = rawSource === "inject" ? "inject" : rawSource === "cli" ? "cli" : "api";
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const results = await search(q, filters, limit, { source, sessionId, project });
    return json({ query: q, results });
  }

  // GET /api/search-history?since=<ISO>&limit=<n>
  if (path === "/api/search-history" && req.method === "GET") {
    const sinceParam = url.searchParams.get("since");
    const limitParam = url.searchParams.get("limit");
    const since = sinceParam !== null && sinceParam !== "" ? new Date(sinceParam) : undefined;
    const limit = limitParam !== null && limitParam !== "" ? parseInt(limitParam, 10) : undefined;
    return json(await loadSearchHistory({ since, limit }));
  }

  // GET /api/search-stats
  if (path === "/api/search-stats" && req.method === "GET") {
    return json(await getSearchStats());
  }

  // ── Session endpoints ──────────────────────────────────────────────────

  // GET /api/sessions?project=...&since=...&limit=...
  if (path === "/api/sessions" && req.method === "GET") {
    const projectFilter = url.searchParams.get("project") ?? undefined;
    const sinceParam = url.searchParams.get("since");
    const limitParam = url.searchParams.get("limit");
    const since = sinceParam !== null && sinceParam !== "" ? new Date(sinceParam) : undefined;
    const limit = limitParam !== null && limitParam !== "" ? parseInt(limitParam, 10) : undefined;
    return json(await getSessionSummaries({ project: projectFilter, since, limit }));
  }

  // ── Repo endpoints ───────────────────────────────────────────────────

  // GET /api/repos — list tracked repos (enriched)
  if (path === "/api/repos" && req.method === "GET") {
    return json(await enrichTrackedRepos());
  }

  // GET /api/repos/scan?root=...&depth=...
  if (path === "/api/repos/scan" && req.method === "GET") {
    const root = url.searchParams.get("root") ?? "~/";
    const depth = parseInt(url.searchParams.get("depth") ?? "4", 10);
    try {
      return json(await discoverRepos(root, depth));
    } catch (err) {
      return json({ error: errorMessage(err) }, 400);
    }
  }

  // POST /api/repos/track
  if (path === "/api/repos/track" && req.method === "POST") {
    try {
      const result = RepoBodySchema.safeParse(await req.json());
      if (!result.success) return json({ error: "absPath required" }, 400);
      const tracked = await trackRepo(result.data.absPath);
      broadcastRepoEvent("repo:tracked", tracked);
      await enqueueRepoSync(result.data.absPath);
      return json(tracked);
    } catch (err) {
      return json({ error: errorMessage(err) }, 400);
    }
  }

  // POST /api/repos/untrack
  if (path === "/api/repos/untrack" && req.method === "POST") {
    try {
      const result = RepoBodySchema.safeParse(await req.json());
      if (!result.success) return json({ error: "absPath required" }, 400);
      const removed = await untrackRepo(result.data.absPath);
      if (!removed) return json({ error: "Not tracked" }, 404);
      broadcastRepoEvent("repo:untracked", { absPath: result.data.absPath });
      return json({ ok: true });
    } catch (err) {
      return json({ error: errorMessage(err) }, 400);
    }
  }

  // POST /api/repos/sync — full context sync (enqueues init-style job)
  if (path === "/api/repos/sync" && req.method === "POST") {
    try {
      const result = RepoBodySchema.safeParse(await req.json());
      if (!result.success) return json({ error: "absPath required" }, 400);
      await updateLastScanned(result.data.absPath);
      await enqueueRepoSync(result.data.absPath);
      return json({ ok: true, message: "Sync job enqueued" });
    } catch (err) {
      return json({ error: errorMessage(err) }, 400);
    }
  }

  // POST /api/repos/open — open repo in VS Code or terminal
  if (path === "/api/repos/open" && req.method === "POST") {
    try {
      const result = RepoOpenBodySchema.safeParse(await req.json());
      if (!result.success) return json({ error: "absPath required" }, 400);
      const { absPath, target } = result.data;
      if (target === "vscode") {
        Bun.spawn(["code", absPath]);
      } else if (target === "terminal") {
        openInTerminal(absPath);
      } else {
        return json({ error: "target must be 'vscode' or 'terminal'" }, 400);
      }
      return json({ ok: true });
    } catch (err) {
      return json({ error: errorMessage(err) }, 400);
    }
  }

  // ── Pipeline helpers ───────────────────────────────────────────────

  function normalizeExecution(exec: PipelineExecution): PipelineExecution {
    return {
      ...exec,
      stages: exec.stages.map((s) => ({ ...s, name: canonicalStageName(s.name) })),
    };
  }

  // ── Pipeline endpoints ─────────────────────────────────────────────

  // GET /api/pipelines?project=...&status=...&limit=...
  if (path === "/api/pipelines" && req.method === "GET") {
    const projectFilter = url.searchParams.get("project") ?? undefined;
    const statusFilter = url.searchParams.get("status") ?? undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);

    const executionIds = await listExecutionIds();
    const executions: PipelineExecution[] = [];

    for (const id of executionIds) {
      try {
        const manifest = await readManifest(id);
        const execution = normalizeExecution(PipelineExecutionSchema.parse(manifest));
        if (projectFilter !== undefined && execution.project !== projectFilter) continue;
        if (statusFilter !== undefined && execution.status !== statusFilter) continue;
        executions.push(execution);
      } catch {
        // skip malformed manifests
      }
    }

    // Sort by startedAt descending
    executions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return json(executions.slice(0, limit));
  }

  // GET /api/pipelines/:executionId
  const pipelineMatch = /^\/api\/pipelines\/([^/]+)$/.exec(path);
  if (pipelineMatch && req.method === "GET") {
    const executionId = decodeURIComponent(pipelineMatch[1]!);
    try {
      const manifest = await readManifest(executionId);
      return json(normalizeExecution(PipelineExecutionSchema.parse(manifest)));
    } catch {
      return json({ error: "Not found" }, 404);
    }
  }

  // GET /api/pipelines/:executionId/messages/:stageName
  const messageMatch = /^\/api\/pipelines\/([^/]+)\/messages\/([^/]+)$/.exec(path);
  if (messageMatch && req.method === "GET") {
    const executionId = decodeURIComponent(messageMatch[1]!);
    const stageName = decodeURIComponent(messageMatch[2]!);
    try {
      const data = await readMessage(executionId, stageName);
      return json(data);
    } catch {
      return json({ error: "Not found" }, 404);
    }
  }

  // GET /api/pipeline-stats
  if (path === "/api/pipeline-stats" && req.method === "GET") {
    const executionIds = await listExecutionIds();
    const stageDurations: Record<string, number[]> = {};
    const stageFailures: Record<string, { total: number; failed: number }> = {};
    let completed = 0;
    let failed = 0;
    let total = 0;

    for (const id of executionIds) {
      try {
        const manifest = await readManifest(id);
        const execution = PipelineExecutionSchema.parse(manifest);
        total++;
        if (execution.status === "completed") completed++;
        if (execution.status === "failed") failed++;

        for (const stage of execution.stages) {
          const name = canonicalStageName(stage.name);
          if (stage.durationMs !== undefined) {
            (stageDurations[name] ??= []).push(stage.durationMs);
          }
          const s = (stageFailures[name] ??= { total: 0, failed: 0 });
          s.total++;
          if (stage.status === "failed") s.failed++;
        }
      } catch {
        // skip
      }
    }

    const avgStageDurations: Record<string, number> = {};
    for (const [name, durations] of Object.entries(stageDurations)) {
      avgStageDurations[name] = durations.reduce((a, b) => a + b, 0) / durations.length;
    }

    const stageFailureRates: Record<string, number> = {};
    for (const [name, counts] of Object.entries(stageFailures)) {
      stageFailureRates[name] = counts.total > 0 ? counts.failed / counts.total : 0;
    }

    return json({
      total,
      completed,
      failed,
      successRate: total > 0 ? completed / total : 0,
      avgStageDurations,
      stageFailureRates,
    });
  }

  return null; // not an API route
}
