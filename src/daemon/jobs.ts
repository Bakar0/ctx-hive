import { mkdir, readdir, rename } from "node:fs/promises";
import { join, basename } from "node:path";
import { z } from "zod";
import { hiveRoot } from "../ctx/store.ts";

// ── Path constants ────────────────────────────────────────────────────

export const JOBS_ROOT = join(hiveRoot(), "jobs");
export const PENDING_DIR = join(JOBS_ROOT, "pending");
export const PROCESSING_DIR = join(JOBS_ROOT, "processing");
export const DONE_DIR = join(JOBS_ROOT, "done");
export const FAILED_DIR = join(JOBS_ROOT, "failed");

// ── Schemas & Types ──────────────────────────────────────────────────

const SessionMineJobSchema = z.object({
  type: z.literal("session-mine"),
  createdAt: z.string(),
  sessionId: z.string(),
  transcriptPath: z.string(),
  cwd: z.string(),
  reason: z.string().optional(),
});

const GitPushJobSchema = z.object({
  type: z.literal("git-push"),
  createdAt: z.string(),
  repoPath: z.string(),
  headSha: z.string(),
  remoteName: z.string(),
  remoteUrl: z.string(),
  refs: z.array(z.object({
    localRef: z.string(),
    localSha: z.string(),
    remoteRef: z.string(),
    remoteSha: z.string(),
  })),
});

const GitPullJobSchema = z.object({
  type: z.literal("git-pull"),
  createdAt: z.string(),
  repoPath: z.string(),
  headSha: z.string(),
  trigger: z.enum(["merge", "rebase"]),
  squash: z.boolean().optional(),
  rewrittenShas: z.array(z.object({ oldSha: z.string(), newSha: z.string() })).optional(),
});

const RepoSyncJobSchema = z.object({
  type: z.literal("repo-sync"),
  createdAt: z.string(),
  repoPath: z.string(),
  cwd: z.string(),
});

export const JobSchema = z.discriminatedUnion("type", [
  SessionMineJobSchema, GitPushJobSchema, GitPullJobSchema, RepoSyncJobSchema,
]);

export type SessionMineJob = z.infer<typeof SessionMineJobSchema>;
export type GitPushJob = z.infer<typeof GitPushJobSchema>;
export type GitPullJob = z.infer<typeof GitPullJobSchema>;
export type RepoSyncJob = z.infer<typeof RepoSyncJobSchema>;
export type Job = z.infer<typeof JobSchema>;

const RawJobRecord = z.record(z.string(), z.unknown());

export const JOB_STATUSES = ["pending", "processing", "done", "failed"] as const;
export type JobStatus = typeof JOB_STATUSES[number];

export interface JobResult {
  success: boolean;
  error?: string;
  duration_ms: number;
  transcriptTokens?: number;
  entriesCreated?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export const RawJobFileSchema = z.object({
  type: z.string().optional(),
  createdAt: z.string().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  reason: z.string().optional(),
  _error: z.string().optional(),
  _failedAt: z.string().optional(),
  _startedAt: z.string().optional(),
  _completedAt: z.string().optional(),
  _duration_ms: z.number().optional(),
  _transcriptTokens: z.number().optional(),
  _entriesCreated: z.number().optional(),
  _inputTokens: z.number().optional(),
  _outputTokens: z.number().optional(),
}).passthrough();

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
  const raw = await Bun.file(path).text();
  return JobSchema.parse(JSON.parse(raw));
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
 * Search done/ for any job matching a predicate.
 */
async function findInDone(predicate: (job: Job) => boolean): Promise<boolean> {
  const doneFiles = await listJobs(DONE_DIR);
  for (const path of doneFiles) {
    try {
      const job = await readJob(path);
      if (predicate(job)) return true;
    } catch {
      // skip malformed
    }
  }
  return false;
}

/**
 * Check if a session has already been processed (exists in done/).
 */
export async function isDuplicate(sessionId: string): Promise<boolean> {
  return findInDone((job) => job.type === "session-mine" && job.sessionId === sessionId);
}

/**
 * Check if a git job with the same HEAD SHA + repo was already processed (exists in done/).
 */
export async function isGitJobProcessed(headSha: string, repoPath: string): Promise<boolean> {
  return findInDone(
    (job) =>
      (job.type === "git-push" || job.type === "git-pull") &&
      job.headSha === headSha &&
      job.repoPath === repoPath,
  );
}

/**
 * Stamp _startedAt on a job file (for live elapsed tracking).
 */
export async function stampStarted(jobPath: string): Promise<void> {
  const raw = await Bun.file(jobPath).text();
  const job = RawJobRecord.parse(JSON.parse(raw));
  job._startedAt = new Date().toISOString();
  await Bun.write(jobPath, JSON.stringify(job, null, 2));
}

/**
 * Write completion metadata and move to done/.
 */
export async function completeJob(jobPath: string, result: JobResult): Promise<string> {
  const raw = await Bun.file(jobPath).text();
  const job = RawJobRecord.parse(JSON.parse(raw));
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
  const raw = await Bun.file(jobPath).text();
  const job = RawJobRecord.parse(JSON.parse(raw));
  job._error = error;
  job._failedAt = new Date().toISOString();
  await Bun.write(jobPath, JSON.stringify(job, null, 2));
  return moveJob(jobPath, FAILED_DIR);
}

// ── Helpers ──────────────────────────────────────────────────────────

export function jobTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Enqueue a repo-sync job for the given repo path.
 */
export async function enqueueRepoSync(repoPath: string): Promise<void> {
  await ensureJobDirs();
  const repoName = basename(repoPath);
  const syncJob: RepoSyncJob = {
    type: "repo-sync",
    repoPath,
    cwd: repoPath,
    createdAt: new Date().toISOString(),
  };
  await writeJob(PENDING_DIR, syncJob, `${jobTimestamp()}-sync-${repoName}.json`);
}
