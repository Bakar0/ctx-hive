import { mkdir, readdir, rename, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { hiveRoot } from "../ctx/store.ts";

// ── Path constants ────────────────────────────────────────────────────

export const JOBS_ROOT = join(hiveRoot(), "jobs");
export const PENDING_DIR = join(JOBS_ROOT, "pending");
export const PROCESSING_DIR = join(JOBS_ROOT, "processing");
export const DONE_DIR = join(JOBS_ROOT, "done");
export const FAILED_DIR = join(JOBS_ROOT, "failed");

// ── Types ─────────────────────────────────────────────────────────────

interface JobBase {
  createdAt: string;
}

export interface SessionMineJob extends JobBase {
  type: "session-mine";
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  reason?: string;
}

export interface GitPushJob extends JobBase {
  type: "git-push";
  repoPath: string;
  headSha: string;
  remoteName: string;
  remoteUrl: string;
  refs: Array<{ localRef: string; localSha: string; remoteRef: string; remoteSha: string }>;
}

export interface GitPullJob extends JobBase {
  type: "git-pull";
  repoPath: string;
  headSha: string;
  trigger: "merge" | "rebase";
  squash?: boolean;
  rewrittenShas?: Array<{ oldSha: string; newSha: string }>;
}

export interface RepoSyncJob extends JobBase {
  type: "repo-sync";
  repoPath: string;
  cwd: string;
}

export type Job = SessionMineJob | GitPushJob | GitPullJob | RepoSyncJob;

export interface JobResult {
  success: boolean;
  error?: string;
  duration_ms: number;
  transcriptTokens?: number;
  entriesCreated?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// ── Directory setup ───────────────────────────────────────────────────

export async function ensureJobDirs(): Promise<void> {
  await Promise.all([
    mkdir(PENDING_DIR, { recursive: true }),
    mkdir(PROCESSING_DIR, { recursive: true }),
    mkdir(DONE_DIR, { recursive: true }),
    mkdir(FAILED_DIR, { recursive: true }),
  ]);
}

// ── Job file I/O ──────────────────────────────────────────────────────

export async function readJob(path: string): Promise<Job> {
  const raw = await readFile(path, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  // oxlint-disable-next-line no-unsafe-type-assertion -- JSON shape validated by callers
  return parsed as Job;
}

export async function writeJob(dir: string, job: Job, filename: string): Promise<string> {
  const path = join(dir, filename);
  await Bun.write(path, JSON.stringify(job, null, 2));
  return path;
}

export async function moveJob(fromPath: string, toDir: string): Promise<string> {
  const dest = join(toDir, basename(fromPath));
  await rename(fromPath, dest);
  return dest;
}

export async function listJobs(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Check if a session has already been processed (exists in done/).
 */
export async function isDuplicate(sessionId: string): Promise<boolean> {
  const doneFiles = await listJobs(DONE_DIR);
  for (const path of doneFiles) {
    try {
      const job = await readJob(path);
      if (job.type === "session-mine" && job.sessionId === sessionId) {
        return true;
      }
    } catch {
      // skip malformed
    }
  }
  return false;
}

/**
 * Check if a git job with the same HEAD SHA + repo was already processed (exists in done/).
 */
export async function isGitJobProcessed(headSha: string, repoPath: string): Promise<boolean> {
  const doneFiles = await listJobs(DONE_DIR);

  for (const path of doneFiles) {
    try {
      const job = await readJob(path);
      if (
        (job.type === "git-push" || job.type === "git-pull") &&
        job.headSha === headSha &&
        job.repoPath === repoPath
      ) {
        return true;
      }
    } catch {
      // skip malformed
    }
  }
  return false;
}

/**
 * Stamp _startedAt on a job file (for live elapsed tracking).
 */
export async function stampStarted(jobPath: string): Promise<void> {
  const raw = await readFile(jobPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  // oxlint-disable-next-line no-unsafe-type-assertion -- augmenting job metadata
  const job = parsed as Record<string, unknown>;
  job._startedAt = new Date().toISOString();
  await Bun.write(jobPath, JSON.stringify(job, null, 2));
}

/**
 * Write completion metadata and move to done/.
 */
export async function completeJob(jobPath: string, result: JobResult): Promise<string> {
  const raw = await readFile(jobPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  // oxlint-disable-next-line no-unsafe-type-assertion -- augmenting job metadata
  const job = parsed as Record<string, unknown>;
  job._completedAt = new Date().toISOString();
  job._duration_ms = result.duration_ms;
  if (result.transcriptTokens !== undefined) job._transcriptTokens = result.transcriptTokens;
  if (result.entriesCreated !== undefined) job._entriesCreated = result.entriesCreated;
  if (result.inputTokens !== undefined) job._inputTokens = result.inputTokens;
  if (result.outputTokens !== undefined) job._outputTokens = result.outputTokens;
  await Bun.write(jobPath, JSON.stringify(job, null, 2));
  return moveJob(jobPath, DONE_DIR);
}

/**
 * Mark a failed job by appending error info and moving to failed/.
 */
export async function failJob(jobPath: string, error: string): Promise<string> {
  const raw = await readFile(jobPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  // oxlint-disable-next-line no-unsafe-type-assertion -- augmenting job metadata
  const job = parsed as Record<string, unknown>;
  job._error = error;
  job._failedAt = new Date().toISOString();
  await Bun.write(jobPath, JSON.stringify(job, null, 2));
  return moveJob(jobPath, FAILED_DIR);
}
