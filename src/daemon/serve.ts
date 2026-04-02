import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hiveRoot } from "../ctx/store.ts";
import { getDb, closeDb } from "../db/connection.ts";
import { seedFromFiles } from "../db/seed.ts";
import { runGit, errorMessage } from "../git/run.ts";
import {
  listJobs,
  readJob,
  failJob,
  isDuplicate,
  isGitJobProcessed,
  isGitChangeProcessed,
  stampStarted,
  completeJob,
} from "./jobs.ts";
import { getHandler } from "./handlers.ts";
import { handleApiRequest } from "./api.ts";
import { wsHandlers, startMetricsBroadcast, stopMetricsBroadcast, broadcastJobEvent } from "./ws.ts";
import { loadTrackedRepos, findTrackedRepoFor } from "../repo/tracking.ts";
import { recomputeAllScores } from "../ctx/signals.ts";
import { pollAllRepos, ensureBranchWatches } from "./branch-watcher.ts";
import dashboardHtmlContent from "../../dashboard/dist/index.html" with { type: "text" };

// ── Constants ─────────────────────────────────────────────────────────

const PID_FILE = join(hiveRoot(), "daemon.pid");
const PORT_FILE = join(hiveRoot(), "daemon.port");
const POLL_INTERVAL_MS = 30_000;
const BRANCH_POLL_INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 100;
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
        // stale PID file, process is dead — clean up stale port file too
        await unlink(PORT_FILE).catch(() => {});
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
const inFlightControllers = new Map<string, AbortController>();

/** Abort an in-flight job by signalling its AbortController. */
export function abortJob(jobId: string): boolean {
  const controller = inFlightControllers.get(jobId);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}

async function processJob(jobId: string): Promise<void> {
  let job;
  try {
    job = readJob(jobId);
  } catch (err) {
    log("error", `failed to read job ${jobId}: ${errorMessage(err)}`);
    try { failJob(jobId, "malformed job file"); } catch { /* already handled */ }
    return;
  }

  const controller = new AbortController();
  inFlightControllers.set(jobId, controller);

  try {
    const handler = getHandler(job.type);
    if (!handler) {
      log("error", `no handler for job type: ${job.type}`);
      failJob(jobId, `unknown job type: ${job.type}`);
      return;
    }

    // Tracked repo filter — skip jobs from untracked repos
    const repoPath = "repoPath" in job ? job.repoPath : ("cwd" in job ? job.cwd : undefined);
    if (repoPath != null && repoPath !== "") {
      const trackedRepos = loadTrackedRepos();
      if (!findTrackedRepoFor(repoPath, trackedRepos)) {
        log("info", `skipping job for untracked repo: ${repoPath}`);
        completeJob(jobId, { success: true, durationMs: 0 });
        return;
      }
    }

    // Duplicate check for session-mine jobs
    if (job.type === "session-mine") {
      if (isDuplicate(job.sessionId)) {
        log("info", `skipping duplicate session: ${job.sessionId.slice(0, 8)}`);
        completeJob(jobId, { success: true, durationMs: 0 });
        return;
      }
    }

    // Duplicate check for git jobs (SHA-based)
    if (job.type === "git-push" || job.type === "git-pull") {
      if (job.headSha !== "" && isGitJobProcessed(job.headSha, job.repoPath)) {
        log("info", `skipping already-processed commit: ${job.headSha.slice(0, 8)} in ${job.repoPath}`);
        completeJob(jobId, { success: true, durationMs: 0 });
        return;
      }
    }

    // Duplicate check for git-change jobs (polling-based)
    if (job.type === "git-change") {
      if (isGitChangeProcessed(job.currentSha, job.repoPath, job.branch)) {
        log("info", `skipping already-processed change: ${job.currentSha.slice(0, 8)} on ${job.branch}`);
        completeJob(jobId, { success: true, durationMs: 0 });
        return;
      }
    }

    // Mark as processing
    stampStarted(jobId);
    log("info", `processing: ${job.type} (${jobId})`);
    broadcastJobEvent("job:started", job);

    const result = await handler(job, { jobId, signal: controller.signal });
    if (result.success) {
      completeJob(jobId, result);
      log("info", `completed: ${job.type} (${(result.durationMs / 1000).toFixed(1)}s)`);
      broadcastJobEvent("job:completed", job);
    } else {
      failJob(jobId, result.error ?? "unknown error");
      log("error", `failed: ${job.type} — ${result.error}`);
      broadcastJobEvent("job:failed", job);
    }
  } catch (err) {
    const msg = errorMessage(err);
    log("error", `job processing error for ${job.type} (${jobId}): ${msg}`);
    try { failJob(jobId, msg); } catch { /* best-effort */ }
    broadcastJobEvent("job:failed", job);
  } finally {
    inFlightControllers.delete(jobId);
  }
}

let draining = false;

async function drainPending(): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    const jobIds = listJobs("pending");
    for (const jobId of jobIds) {
      if (shuttingDown) break;
      if (inFlightJobs.size >= maxConcurrency) {
        await Promise.race(inFlightJobs);
      }
      if (shuttingDown) break;

      const jobPromise = processJob(jobId)
        .catch((err) => {
          log("error", `unexpected job error: ${errorMessage(err)}`);
        })
        .finally(() => {
          inFlightJobs.delete(jobPromise);
        });
      inFlightJobs.add(jobPromise);
    }
  } finally {
    draining = false;
  }
}

// ── Nudge-triggered drain ─────────────────────────────────────────────

let drainTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced drain trigger — called by the nudge API endpoint. */
export function triggerDrain(): void {
  if (drainTimer !== null) return; // already scheduled
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drainPending();
  }, DEBOUNCE_MS);
}

// ── Orphan recovery ───────────────────────────────────────────────────

function recoverOrphans(): void {
  const db = getDb();
  // Reset any jobs stuck in 'processing' back to 'pending'
  const jobResult = db.prepare("UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'processing'").run();
  if (jobResult.changes > 0) {
    log("warn", `recovered ${jobResult.changes} orphaned job(s) from processing`);
  }

  // Fail any pipeline stages/executions stuck in 'running' (from a prior daemon crash)
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE pipeline_stages SET status = 'failed', error = 'daemon restarted'
       WHERE status = 'running'
         AND execution_id IN (SELECT id FROM pipeline_executions WHERE status = 'running')`,
    ).run();
    const pipelineResult = db.prepare(
      "UPDATE pipeline_executions SET status = 'failed', completed_at = ? WHERE status = 'running'",
    ).run(now);
    if (pipelineResult.changes > 0) {
      log("warn", `recovered ${pipelineResult.changes} orphaned pipeline(s) from running`);
    }
  })();
}

// ── Dashboard HTML (embedded at build time) ──────────────────────────

const DASHBOARD_HTML = String(dashboardHtmlContent);
const DASHBOARD_ETAG = `"${Bun.hash(DASHBOARD_HTML).toString(36)}"`;


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
        if (upgraded) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // API routes
      const apiResponse = await handleApiRequest(req, url);
      if (apiResponse) return apiResponse;

      // Dashboard (serve HTML for everything else)
      if (req.headers.get("If-None-Match") === DASHBOARD_ETAG) {
        return new Response(null, { status: 304 });
      }
      return new Response(DASHBOARD_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "ETag": DASHBOARD_ETAG,
        },
      });
    },
    websocket: wsHandlers,
  });

  log("info", `dashboard running at http://localhost:${port}`);
}

// ── Shutdown ──────────────────────────────────────────────────────────

let shuttingDown = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let branchPollTimer: ReturnType<typeof setInterval> | null = null;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutting down...");

  stopMetricsBroadcast();

  if (httpServer) {
    void httpServer.stop();
    httpServer = null;
  }

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (branchPollTimer) {
    clearInterval(branchPollTimer);
    branchPollTimer = null;
  }

  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }

  // Wait for all in-flight jobs to complete
  if (inFlightJobs.size > 0) {
    log("info", `waiting for ${inFlightJobs.size} in-flight job(s) to finish...`);
    await Promise.allSettled(inFlightJobs);
  }

  closeDb();
  await releasePidLock();
  await unlink(PORT_FILE).catch(() => {});
  log("info", "daemon stopped");
}

// ── Legacy hook migration ────────────────────────────────────────────

async function migrateLegacyHooks(): Promise<void> {
  const output = await runGit(["config", "--global", "core.hooksPath"], ".");
  if (output !== "" && (output.includes("ctx-hive") || output.includes(".ctx-hive"))) {
    await runGit(["config", "--global", "--unset", "core.hooksPath"], ".");
    log("info", "migrated: removed legacy ctx-hive global git hooks (core.hooksPath)");
  }
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

  // Initialize database and seed from existing files if needed
  getDb();
  try {
    const seedResult = await seedFromFiles(getDb());
    if (!seedResult.skipped) {
      log("info", `seeded DB: ${seedResult.entries} entries, ${seedResult.jobs} jobs, ${seedResult.pipelines} pipelines`);
    }
  } catch (err) {
    log("error", `DB seed failed: ${errorMessage(err)}`);
  }

  const acquired = await acquirePidLock();
  if (!acquired) {
    console.error("Another ctx-hive daemon is already running. Check ~/.ctx-hive/daemon.pid");
    process.exit(1);
  }

  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  process.on("uncaughtException", (err) => {
    log("error", `uncaught exception: ${errorMessage(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    log("error", `unhandled rejection: ${errorMessage(reason)}`);
  });

  log("info", `daemon started (pid ${process.pid}, concurrency ${maxConcurrency})`);

  // Start the HTTP + WebSocket server
  startHttpServer(port);
  await writeFile(PORT_FILE, String(port));
  startMetricsBroadcast(5_000);

  // Recover orphaned jobs from previous crash
  try {
    recoverOrphans();
  } catch (err) {
    log("error", `orphan recovery failed: ${errorMessage(err)}`);
  }

  // Recompute signal scores and prune stale data
  try {
    recomputeAllScores();
  } catch (err) {
    log("error", `score recomputation failed: ${errorMessage(err)}`);
  }

  // Drain any pending jobs that accumulated while daemon was down
  try {
    await drainPending();
  } catch (err) {
    log("error", `initial drain failed: ${errorMessage(err)}`);
  }

  // Poll for new jobs (DB-backed — no file watcher needed)
  pollTimer = setInterval(() => {
    debug("poll sweep");
    void drainPending();
  }, POLL_INTERVAL_MS);

  // Initialize branch watches for any tracked repos that don't have them yet
  try {
    await ensureBranchWatches();
  } catch (err) {
    log("error", `branch watch init failed: ${errorMessage(err)}`);
  }

  // Auto-uninstall legacy git hooks if core.hooksPath points to ctx-hive
  try {
    await migrateLegacyHooks();
  } catch (err) {
    log("error", `legacy hook migration failed: ${errorMessage(err)}`);
  }

  // Initial branch poll to catch up on changes while daemon was down
  try {
    const changes = await pollAllRepos();
    if (changes > 0) {
      log("info", `initial branch poll found ${changes} change(s)`);
      void drainPending();
    }
  } catch (err) {
    log("error", `initial branch poll failed: ${errorMessage(err)}`);
  }

  // Poll remote branches for changes
  branchPollTimer = setInterval(() => {
    debug("branch poll sweep");
    void pollAllRepos().then((changes) => {
      if (changes > 0) {
        log("info", `branch poll found ${changes} change(s)`);
        void drainPending();
      }
    }).catch((err) => {
      log("error", `branch poll failed: ${errorMessage(err)}`);
    });
  }, BRANCH_POLL_INTERVAL_MS);
}
