import { watch, type FSWatcher } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hiveRoot } from "../ctx/store.ts";
import { errorMessage } from "../git/run.ts";
import {
  ensureJobDirs,
  listJobs,
  readJob,
  moveJob,
  failJob,
  isDuplicate,
  isGitJobProcessed,
  stampStarted,
  completeJob,
  PENDING_DIR,
  PROCESSING_DIR,
  DONE_DIR,
} from "./jobs.ts";
import { getHandler } from "./handlers.ts";
import { handleApiRequest } from "./api.ts";
import { wsHandlers, startMetricsBroadcast, stopMetricsBroadcast, broadcastJobEvent, markMetricsDirty } from "./ws.ts";
import { loadTrackedRepos } from "../repo/tracking.ts";
import { recomputeAllScores } from "../ctx/signals.ts";
import dashboardHtmlContent from "./dashboard.html" with { type: "text" };

// ── Constants ─────────────────────────────────────────────────────────

const PID_FILE = join(hiveRoot(), "daemon.pid");
const POLL_INTERVAL_MS = 30_000;
const DASHBOARD_PORT = 3939;

// ── Logging ───────────────────────────────────────────────────────────

let verbose = false;

function log(level: "info" | "error" | "warn", msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

function debug(msg: string): void {
  if (verbose) log("info", msg);
}

// ── PID file ──────────────────────────────────────────────────────────

async function acquirePidLock(): Promise<boolean> {
  try {
    const existing = await readFile(PID_FILE, "utf-8").catch(() => null);
    if (existing != null && existing !== "") {
      const pid = parseInt(existing.trim(), 10);
      try {
        process.kill(pid, 0); // check if process is alive
        return false; // another daemon is running
      } catch {
        // stale PID file, process is dead
      }
    }
    await writeFile(PID_FILE, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

async function releasePidLock(): Promise<void> {
  try {
    await unlink(PID_FILE);
  } catch {
    // ignore
  }
}

// ── Job processing ────────────────────────────────────────────────────

let maxConcurrency = 3;
const inFlightJobs = new Set<Promise<void>>();

async function processJob(jobPath: string): Promise<void> {
  let job;
  try {
    job = await readJob(jobPath);
  } catch (err) {
    log("error", `failed to read job ${jobPath}: ${errorMessage(err)}`);
    await failJob(jobPath, "malformed job file");
    return;
  }

  const handler = getHandler(job.type);
  if (!handler) {
    log("error", `no handler for job type: ${job.type}`);
    await failJob(jobPath, `unknown job type: ${job.type}`);
    return;
  }

  // Tracked repo filter — skip jobs from untracked repos
  const repoPath = "repoPath" in job ? job.repoPath : ("cwd" in job ? job.cwd : undefined);
  if (repoPath != null && repoPath !== "") {
    const trackedRepos = await loadTrackedRepos();
    const normalized = resolve(repoPath);
    if (!trackedRepos.some((r) => r.absPath === normalized)) {
      log("info", `skipping job for untracked repo: ${repoPath}`);
      await moveJob(jobPath, DONE_DIR);
      return;
    }
  }

  // Duplicate check for session-mine jobs
  if (job.type === "session-mine") {
    if (await isDuplicate(job.sessionId)) {
      log("info", `skipping duplicate session: ${job.sessionId.slice(0, 8)}`);
      await moveJob(jobPath, DONE_DIR);
      return;
    }
  }

  // Duplicate check for git jobs (SHA-based)
  if (job.type === "git-push" || job.type === "git-pull") {
    if (job.headSha !== "" && await isGitJobProcessed(job.headSha, job.repoPath)) {
      log("info", `skipping already-processed commit: ${job.headSha.slice(0, 8)} in ${job.repoPath}`);
      await moveJob(jobPath, DONE_DIR);
      return;
    }
  }

  // Move to processing and stamp start time
  const processingPath = await moveJob(jobPath, PROCESSING_DIR);
  await stampStarted(processingPath);
  log("info", `processing: ${job.type} (${jobPath})`);
  broadcastJobEvent("job:started", job);

  try {
    const result = await handler(job);
    if (result.success) {
      await completeJob(processingPath, result);
      log("info", `completed: ${job.type} (${(result.duration_ms / 1000).toFixed(1)}s)`);
      broadcastJobEvent("job:completed", job);
    } else {
      await failJob(processingPath, result.error ?? "unknown error");
      log("error", `failed: ${job.type} — ${result.error}`);
      broadcastJobEvent("job:failed", job);
    }
  } catch (err) {
    const msg = errorMessage(err);
    await failJob(processingPath, msg);
    log("error", `failed: ${job.type} — ${msg}`);
    broadcastJobEvent("job:failed", job);
  }
}

let draining = false;

async function drainPending(): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    const jobs = await listJobs(PENDING_DIR);
    for (const jobPath of jobs) {
      if (shuttingDown) break;
      if (inFlightJobs.size >= maxConcurrency) {
        await Promise.race(inFlightJobs);
      }
      if (shuttingDown) break;

      const jobPromise = processJob(jobPath).finally(() => {
        inFlightJobs.delete(jobPromise);
      });
      inFlightJobs.add(jobPromise);
    }
  } finally {
    draining = false;
  }
}

// ── Orphan recovery ───────────────────────────────────────────────────

async function recoverOrphans(): Promise<void> {
  const orphans = await listJobs(PROCESSING_DIR);
  for (const path of orphans) {
    log("warn", `recovering orphaned job: ${path}`);
    await moveJob(path, PENDING_DIR);
  }
}

// ── Dashboard HTML (embedded at build time) ──────────────────────────

// oxlint-disable-next-line no-unsafe-type-assertion -- Bun text import is always a string at runtime
const DASHBOARD_HTML = dashboardHtmlContent as unknown as string;

// ── HTTP + WebSocket Server ───────────────────────────────────────────

let httpServer: ReturnType<typeof Bun.serve> | null = null;

function startHttpServer(port: number): void {
  httpServer = Bun.serve({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, { data: {} });
        // Bun.serve expects undefined for upgraded WebSocket connections
        // oxlint-disable-next-line no-unsafe-type-assertion
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // API routes
      const apiResponse = await handleApiRequest(req, url);
      if (apiResponse) return apiResponse;

      // Dashboard (serve HTML for everything else)
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
    websocket: wsHandlers,
  });

  log("info", `dashboard running at http://localhost:${port}`);
}

// ── Shutdown ──────────────────────────────────────────────────────────

let shuttingDown = false;
let watcher: FSWatcher | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutting down...");

  stopMetricsBroadcast();

  if (httpServer) {
    void httpServer.stop();
    httpServer = null;
  }

  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // Wait for all in-flight jobs to complete
  if (inFlightJobs.size > 0) {
    log("info", `waiting for ${inFlightJobs.size} in-flight job(s) to finish...`);
    await Promise.allSettled(inFlightJobs);
  }

  await releasePidLock();
  log("info", "daemon stopped");
}

// ── Main entry ────────────────────────────────────────────────────────

export async function serve(args: string[]): Promise<void> {
  verbose = args.includes("--verbose");

  // Parse --port flag
  const portIdx = args.indexOf("--port");
  const portArg = portIdx !== -1 ? args[portIdx + 1] : undefined;
  const port = portArg !== undefined && portArg !== "" ? parseInt(portArg, 10) : DASHBOARD_PORT;

  const concurrencyIdx = args.indexOf("--concurrency");
  const concurrencyArg = concurrencyIdx !== -1 ? args[concurrencyIdx + 1] : undefined;
  if (concurrencyArg !== undefined && concurrencyArg !== "") {
    const parsed = parseInt(concurrencyArg, 10);
    if (parsed > 0) maxConcurrency = parsed;
  }

  await ensureJobDirs();

  const acquired = await acquirePidLock();
  if (!acquired) {
    console.error("Another ctx-hive daemon is already running. Check ~/.ctx-hive/daemon.pid");
    process.exit(1);
  }

  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  log("info", `daemon started (pid ${process.pid}, concurrency ${maxConcurrency}), watching ${PENDING_DIR}`);

  // Start the HTTP + WebSocket server
  startHttpServer(port);
  startMetricsBroadcast(5_000);

  // Recover orphaned jobs from previous crash
  await recoverOrphans();

  // Recompute signal scores and prune stale data
  await recomputeAllScores();

  // Drain any pending jobs that accumulated while daemon was down
  await drainPending();

  // Watch for new jobs
  watcher = watch(PENDING_DIR, () => {
    debug("fs.watch triggered");
    markMetricsDirty();
    void drainPending();
  });

  // Fallback poll (fs.watch can be unreliable)
  pollTimer = setInterval(() => {
    debug("poll sweep");
    void drainPending();
  }, POLL_INTERVAL_MS);
}
