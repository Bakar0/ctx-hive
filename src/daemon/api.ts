/**
 * REST API endpoints for the ctx-hive dashboard.
 * Provides read access to jobs, memories, pipelines, and metrics.
 */
import { basename } from "node:path";
import { z } from "zod";
import { getDb, isSqliteVecAvailable } from "../db/connection.ts";
import {
  loadIndex,
  loadIndexEntries,
  deleteEntry,
  resolveEntry,
  type IndexEntry,
  isScope,
  SCOPES,
} from "../ctx/store.ts";
import {
  enqueueRepoSync,
  JOB_STATUSES,
  type JobStatus,
} from "./jobs.ts";
import {
  trackRepo,
  untrackRepo,
  updateLastScanned,
} from "../repo/tracking.ts";
import { loadSignals } from "../ctx/signals.ts";
import { searchMulti, type SearchFilters } from "../ctx/search.ts";
import { loadSearchHistory, getSearchStats, getSearchAnalytics, type SearchSource } from "../ctx/search-history.ts";
import { setSetting, getVectorSearchConfig } from "../ctx/settings.ts";
import { validateApiKey } from "../ctx/embeddings.ts";
import { countEmbeddings } from "../ctx/vector-search.ts";
import { backfillEmbeddings, getBackfillState } from "../ctx/backfill-embeddings.ts";
import {
  discoverRepos,
  enrichTrackedRepos,
} from "../repo/scanner.ts";
import { broadcastRepoEvent, broadcastJobEvent, markMetricsDirty } from "./ws.ts";
import { triggerDrain, abortJob } from "./serve.ts";
import { errorMessage } from "../git/run.ts";
import { listExecutions, readManifest, readMessage, canonicalStageName } from "../pipeline/messages.ts";
import { PipelineExecutionSchema, type PipelineExecution } from "../pipeline/schema.ts";

// ── Types ─────────────────────────────────────────────────────────────

export interface JobView {
  jobId: string;
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
  memories: {
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

export function projectFromCwd(cwd?: string): string {
  if (cwd === undefined || cwd === "") return "unknown";
  return basename(cwd);
}

const RepoBodySchema = z.object({ absPath: z.string().min(1) });
const RepoOpenBodySchema = z.object({ absPath: z.string().min(1), target: z.string().optional() });

interface JobIdRow { job_id: string }

/** Resolve a pipeline execution ID to its owning job ID. */
function findJobIdForExecution(executionId: string): string | undefined {
  const db = getDb();
  const row = db.prepare<JobIdRow, [string]>("SELECT job_id FROM pipeline_executions WHERE id = ?").get(executionId);
  if (row == null) return undefined;
  if (row.job_id !== "") return row.job_id;
  // Fallback: find via pipeline_data JSON containing the execution id (any status)
  const jobRow = db.prepare<JobIdRow, [string]>("SELECT job_id FROM jobs WHERE pipeline_data LIKE ? LIMIT 1").get(`%${executionId}%`);
  if (jobRow != null) return jobRow.job_id;
  return undefined;
}


// ── API Functions ─────────────────────────────────────────────────────

interface JobDbRow {
  job_id: string; type: string; status: string; payload: string;
  error: string | null; created_at: string; started_at: string | null;
  completed_at: string | null; failed_at: string | null;
  duration_ms: number | null; transcript_tokens: number | null;
  entries_created: number | null; input_tokens: number | null;
  output_tokens: number | null; pipeline_data: string | null;
}

const JobStatusSchema = z.enum(JOB_STATUSES);
const PayloadSchema = z.record(z.string(), z.string().optional());
const PipelineDataSchema = z.unknown();

function jobDbRowToView(r: JobDbRow): JobView {
  const payload = PayloadSchema.parse(JSON.parse(r.payload));
  return {
    jobId: r.job_id,
    status: JobStatusSchema.parse(r.status),
    type: r.type,
    createdAt: r.created_at,
    sessionId: payload.sessionId,
    cwd: payload.cwd,
    project: projectFromCwd(payload.cwd ?? payload.repoPath),
    reason: payload.reason,
    error: r.error ?? undefined,
    failedAt: r.failed_at ?? undefined,
    startedAt: r.started_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    transcriptTokens: r.transcript_tokens ?? undefined,
    entriesCreated: r.entries_created ?? undefined,
    inputTokens: r.input_tokens ?? undefined,
    outputTokens: r.output_tokens ?? undefined,
    pipeline: r.pipeline_data !== null ? PipelineDataSchema.parse(JSON.parse(r.pipeline_data)) : undefined,
  };
}

export function getAllJobs(): JobView[] {
  const db = getDb();
  const rows = db.prepare<JobDbRow, []>("SELECT * FROM jobs ORDER BY created_at DESC").all();
  return rows.map(jobDbRowToView);
}

export function getMemories(params: {
  scope?: string;
  project?: string;
  sortBy?: "time" | "project";
}): (IndexEntry & { body: string })[] {
  let full = loadIndexEntries();

  if (params.scope != null && params.scope !== "" && (SCOPES as readonly string[]).includes(params.scope)) {
    full = full.filter((e) => e.scope === params.scope);
  }
  if (params.project != null && params.project !== "") {
    full = full.filter((e) => e.project === params.project);
  }

  if (params.sortBy === "project") {
    full.sort((a, b) => a.project.localeCompare(b.project) || b.updated.localeCompare(a.updated));
  } else {
    full.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  return full;
}

export async function getMetrics(): Promise<MetricsSnapshot> {
  const db = getDb();

  // Job counts by status
  const jobCounts = db.prepare<{ status: string; cnt: number }, []>(
    "SELECT status, COUNT(*) as cnt FROM jobs GROUP BY status",
  ).all();
  const statusMap = new Map(jobCounts.map((r) => [r.status, r.cnt]));
  const jobsPending = statusMap.get("pending") ?? 0;
  const jobsProcessing = statusMap.get("processing") ?? 0;
  const jobsDone = statusMap.get("done") ?? 0;
  const jobsFailed = statusMap.get("failed") ?? 0;
  const total = jobsPending + jobsProcessing + jobsDone + jobsFailed;

  // Entry counts by scope and project
  const scopeCounts = db.prepare<{ scope: string; cnt: number }, []>(
    "SELECT scope, COUNT(*) as cnt FROM entries GROUP BY scope",
  ).all();
  const byScope: Record<string, number> = {};
  let memoryTotal = 0;
  for (const row of scopeCounts) {
    byScope[row.scope] = row.cnt;
    memoryTotal += row.cnt;
  }

  const projectCounts = db.prepare<{ project: string; cnt: number }, []>(
    "SELECT project, COUNT(*) as cnt FROM entries WHERE project != '' GROUP BY project",
  ).all();
  const byProject: Record<string, number> = {};
  for (const row of projectCounts) {
    byProject[row.project] = row.cnt;
  }

  // Recent jobs (only fetch 20)
  const recentRows = db.prepare<JobDbRow, []>(
    "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 20",
  ).all();
  const recentJobs = recentRows.map(jobDbRowToView);

  return {
    timestamp: new Date().toISOString(),
    jobs: { pending: jobsPending, processing: jobsProcessing, done: jobsDone, failed: jobsFailed, total },
    memories: { total: memoryTotal, byScope, byProject },
    recentJobs,
  };
}

export function deleteMemoryById(idOrSlug: string): boolean {
  const resolved = resolveEntry(idOrSlug);
  if (!resolved) return false;
  deleteEntry(resolved.scope, resolved.slug);
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

export function getSessionSummaries(opts?: {
  project?: string;
  since?: Date;
  limit?: number;
}): SessionSummary[] {
  const records = loadSearchHistory();
  const signals = loadSignals();

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
    return json(getAllJobs());
  }

  // POST /api/jobs/:jobId/requeue
  const requeueMatch = /^\/api\/jobs\/(.+)\/requeue$/.exec(path);
  if (requeueMatch && req.method === "POST") {
    const jobId = decodeURIComponent(requeueMatch[1]!);
    const db = getDb();
    const result = db.prepare(
      "UPDATE jobs SET status = 'pending', error = NULL, failed_at = NULL, started_at = NULL, completed_at = NULL, duration_ms = NULL, entries_created = NULL, input_tokens = NULL, output_tokens = NULL, transcript_tokens = NULL, pipeline_data = NULL WHERE job_id = ? AND status IN ('failed', 'processing')",
    ).run(jobId);
    if (result.changes === 0) return json({ error: "Job not found or not in failed/processing state" }, 404);
    return json({ ok: true });
  }

  // POST /api/jobs/:jobId/cancel — force-fail a processing or pending job
  const cancelMatch = /^\/api\/jobs\/(.+)\/cancel$/.exec(path);
  if (cancelMatch && req.method === "POST") {
    const jobId = decodeURIComponent(cancelMatch[1]!);
    const db = getDb();
    const result = db.prepare(
      "UPDATE jobs SET status = 'failed', error = 'manually cancelled', failed_at = ? WHERE job_id = ? AND status IN ('processing', 'pending')",
    ).run(new Date().toISOString(), jobId);
    if (result.changes === 0) return json({ error: "Job not found or not in cancellable state" }, 404);
    abortJob(jobId);
    broadcastJobEvent("job:failed", { jobId });
    markMetricsDirty();
    return json({ ok: true });
  }

  // POST /api/jobs/nudge — trigger immediate drain of pending jobs
  if (path === "/api/jobs/nudge" && req.method === "POST") {
    markMetricsDirty();
    triggerDrain();
    return json({ ok: true });
  }

  // GET /api/memories?scope=...&project=...&sortBy=time|project
  if (path === "/api/memories" && req.method === "GET") {
    const scope = url.searchParams.get("scope") ?? undefined;
    const project = url.searchParams.get("project") ?? undefined;
    const sortByParam = url.searchParams.get("sortBy");
    const sortBy = sortByParam === "project" ? "project" : "time";
    return json(getMemories({ scope, project, sortBy }));
  }

  // DELETE /api/memories/:id
  const deleteMatch = /^\/api\/memories\/(.+)$/.exec(path);
  if (deleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(deleteMatch[1]!);
    const deleted = deleteMemoryById(id);
    if (deleted) return json({ ok: true });
    return json({ error: "Not found" }, 404);
  }

  // GET /api/projects — unique project list
  if (path === "/api/projects" && req.method === "GET") {
    const index = loadIndex();
    const projects = [...new Set(index.map((e) => e.project).filter(Boolean))].sort();
    return json(projects);
  }

  // GET /api/signals
  if (path === "/api/signals" && req.method === "GET") {
    return json(loadSignals());
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

    const result = await searchMulti(q, filters, limit, { source, sessionId, project });
    return json({ query: q, ...result });
  }

  // GET /api/search-history?since=<ISO>&limit=<n>
  if (path === "/api/search-history" && req.method === "GET") {
    const sinceParam = url.searchParams.get("since");
    const limitParam = url.searchParams.get("limit");
    const since = sinceParam !== null && sinceParam !== "" ? new Date(sinceParam) : undefined;
    const limit = limitParam !== null && limitParam !== "" ? parseInt(limitParam, 10) : undefined;
    return json(loadSearchHistory({ since, limit }));
  }

  // GET /api/search-stats
  if (path === "/api/search-stats" && req.method === "GET") {
    return json(getSearchStats());
  }

  // GET /api/search-analytics
  if (path === "/api/search-analytics" && req.method === "GET") {
    return json(getSearchAnalytics());
  }

  // ── Vector search settings endpoints ────────────────────────────────

  // GET /api/settings/vector-search
  if (path === "/api/settings/vector-search" && req.method === "GET") {
    const config = getVectorSearchConfig();
    const db = getDb();
    const totalCount = db.prepare<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM entries").get()!.cnt;
    const embeddedCount = countEmbeddings();
    return json({
      enabled: config.enabled,
      model: config.model,
      hasApiKey: config.apiKey !== null,
      embeddedCount,
      totalCount,
      sqliteVecAvailable: isSqliteVecAvailable(),
    });
  }

  // POST /api/settings/vector-search
  if (path === "/api/settings/vector-search" && req.method === "POST") {
    try {
      const body = z.object({
        enabled: z.boolean().optional(),
        apiKey: z.string().optional(),
        model: z.string().optional(),
      }).parse(await req.json());

      if (typeof body.apiKey === "string" && body.apiKey !== "") {
        const model = body.model ?? getVectorSearchConfig().model;
        const valid = await validateApiKey(body.apiKey, model);
        if (!valid) return json({ error: "Invalid API key — test embedding call failed" }, 400);
        setSetting("vector_search.api_key", body.apiKey);
      }

      if (typeof body.model === "string" && body.model !== "") {
        setSetting("vector_search.model", body.model);
      }

      let backfillStarted = false;
      if (typeof body.enabled === "boolean") {
        setSetting("vector_search.enabled", String(body.enabled));

        // Trigger backfill when enabling with a valid key
        if (body.enabled) {
          const config = getVectorSearchConfig();
          if (config.apiKey !== null) {
            backfillEmbeddings().catch((err) =>
              console.error("[backfill] Error:", err),
            );
            backfillStarted = true;
          }
        }
      }

      return json({ ok: true, backfillStarted });
    } catch (err) {
      return json({ error: errorMessage(err) }, 400);
    }
  }

  // POST /api/settings/vector-search/backfill
  if (path === "/api/settings/vector-search/backfill" && req.method === "POST") {
    const config = getVectorSearchConfig();
    if (!config.enabled || config.apiKey === null) {
      return json({ error: "Vector search not enabled or API key not set" }, 400);
    }
    backfillEmbeddings().catch((err) =>
      console.error("[backfill] Error:", err),
    );
    return json({ ok: true });
  }

  // GET /api/settings/vector-search/status
  if (path === "/api/settings/vector-search/status" && req.method === "GET") {
    return json(getBackfillState());
  }

  // ── Session endpoints ──────────────────────────────────────────────────

  // GET /api/sessions?project=...&since=...&limit=...
  if (path === "/api/sessions" && req.method === "GET") {
    const projectFilter = url.searchParams.get("project") ?? undefined;
    const sinceParam = url.searchParams.get("since");
    const limitParam = url.searchParams.get("limit");
    const since = sinceParam !== null && sinceParam !== "" ? new Date(sinceParam) : undefined;
    const limit = limitParam !== null && limitParam !== "" ? parseInt(limitParam, 10) : undefined;
    return json(getSessionSummaries({ project: projectFilter, since, limit }));
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
      enqueueRepoSync(result.data.absPath);
      triggerDrain();
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
      const removed = untrackRepo(result.data.absPath);
      if (!removed) return json({ error: "Not tracked" }, 404);
      broadcastRepoEvent("repo:untracked", { absPath: result.data.absPath });
      return json({ ok: true });
    } catch (err) {
      return json({ error: errorMessage(err) }, 400);
    }
  }

  // POST /api/repos/sync — full memory sync (enqueues init-style job)
  if (path === "/api/repos/sync" && req.method === "POST") {
    try {
      const result = RepoBodySchema.safeParse(await req.json());
      if (!result.success) return json({ error: "absPath required" }, 400);
      updateLastScanned(result.data.absPath);
      enqueueRepoSync(result.data.absPath);
      triggerDrain();
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

    const manifests = listExecutions({ project: projectFilter, status: statusFilter, limit });
    const executions = manifests.map((m) => normalizeExecution(PipelineExecutionSchema.parse(m)));
    return json(executions);
  }

  // GET /api/pipelines/:executionId
  const pipelineMatch = /^\/api\/pipelines\/([^/]+)$/.exec(path);
  if (pipelineMatch && req.method === "GET") {
    const executionId = decodeURIComponent(pipelineMatch[1]!);
    try {
      const manifest = readManifest(executionId);
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
      const data = readMessage(executionId, stageName);
      return json(data);
    } catch {
      return json({ error: "Not found" }, 404);
    }
  }

  // POST /api/pipelines/:executionId/cancel
  const pipelineCancelMatch = /^\/api\/pipelines\/([^/]+)\/cancel$/.exec(path);
  if (pipelineCancelMatch && req.method === "POST") {
    const executionId = decodeURIComponent(pipelineCancelMatch[1]!);
    const jobId = findJobIdForExecution(executionId);
    if (jobId === undefined) return json({ error: "Pipeline or linked job not found" }, 404);
    const db = getDb();
    const result = db.prepare(
      "UPDATE jobs SET status = 'failed', error = 'manually cancelled', failed_at = ? WHERE job_id = ? AND status IN ('processing', 'pending')",
    ).run(new Date().toISOString(), jobId);
    if (result.changes === 0) return json({ error: "Job not in cancellable state" }, 404);
    abortJob(jobId);
    broadcastJobEvent("job:failed", { jobId });
    markMetricsDirty();
    return json({ ok: true });
  }

  // POST /api/pipelines/:executionId/rerun
  const pipelineRerunMatch = /^\/api\/pipelines\/([^/]+)\/rerun$/.exec(path);
  if (pipelineRerunMatch && req.method === "POST") {
    const executionId = decodeURIComponent(pipelineRerunMatch[1]!);
    const jobId = findJobIdForExecution(executionId);
    if (jobId === undefined) return json({ error: "Pipeline or linked job not found" }, 404);
    const db = getDb();
    const result = db.prepare(
      "UPDATE jobs SET status = 'pending', error = NULL, failed_at = NULL, started_at = NULL, completed_at = NULL, duration_ms = NULL, entries_created = NULL, input_tokens = NULL, output_tokens = NULL, transcript_tokens = NULL, pipeline_data = NULL WHERE job_id = ? AND status IN ('failed', 'done', 'processing')",
    ).run(jobId);
    if (result.changes === 0) return json({ error: "Job not found or not in retriable state" }, 404);
    db.prepare("UPDATE pipeline_executions SET status = 'requeued' WHERE id = ?").run(executionId);
    markMetricsDirty();
    triggerDrain();
    return json({ ok: true });
  }

  // GET /api/pipeline-stats
  if (path === "/api/pipeline-stats" && req.method === "GET") {
    const manifests = listExecutions();
    const stageDurations: Record<string, number[]> = {};
    const stageFailures: Record<string, { total: number; failed: number }> = {};
    let completed = 0;
    let failed = 0;

    for (const manifest of manifests) {
      const execution = PipelineExecutionSchema.parse(manifest);
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
    }

    const avgStageDurations: Record<string, number> = {};
    for (const [name, durations] of Object.entries(stageDurations)) {
      avgStageDurations[name] = durations.reduce((a, b) => a + b, 0) / durations.length;
    }

    const stageFailureRates: Record<string, number> = {};
    for (const [name, counts] of Object.entries(stageFailures)) {
      stageFailureRates[name] = counts.total > 0 ? counts.failed / counts.total : 0;
    }

    const total = manifests.length;
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
