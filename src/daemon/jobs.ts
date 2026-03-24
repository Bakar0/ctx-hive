import { basename } from "node:path";
import { z } from "zod";
import { getDb } from "../db/connection.ts";
import { PipelineExecutionSchema, type PipelineExecution } from "../pipeline/schema.ts";

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

export const JOB_STATUSES = ["pending", "processing", "done", "failed"] as const;
export type JobStatus = typeof JOB_STATUSES[number];

export interface JobResult {
  success: boolean;
  error?: string;
  durationMs: number;
  transcriptTokens?: number;
  entriesCreated?: number;
  inputTokens?: number;
  outputTokens?: number;
  pipeline?: PipelineExecution;
}

export const RawJobFileSchema = z.object({
  type: z.string().optional(),
  createdAt: z.string().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  repoPath: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  failedAt: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  transcriptTokens: z.number().optional(),
  entriesCreated: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  pipeline: PipelineExecutionSchema.optional(),
}).passthrough();

// ── Directory setup (no-op — DB handles storage) ─────────────────────

export function ensureJobDirs(): void {
  // No-op — DB handles storage
}

// ── Job I/O ──────────────────────────────────────────────────────────

export function readJob(filenameOrPath: string): Job {
  const db = getDb();
  const filename = basename(filenameOrPath);
  const row = db.prepare<{ payload: string }, [string]>("SELECT payload FROM jobs WHERE filename = ?").get(filename);
  if (!row) throw new Error(`Job not found: ${filename}`);
  return JobSchema.parse(JSON.parse(row.payload));
}

export function writeJob(_dir: string, job: Job, filename: string): string {
  const db = getDb();
  db.prepare(`
    INSERT INTO jobs (filename, type, status, payload, created_at)
    VALUES (?, ?, 'pending', ?, ?)
  `).run(filename, job.type, JSON.stringify(job), job.createdAt);
  return filename;
}

export function moveJob(filenameOrPath: string, _toDir: string): string {
  // In the DB model, moveJob is no longer needed — status updates are handled directly.
  // This function is kept for backward compat but is a no-op.
  return basename(filenameOrPath);
}

export function listJobs(dirOrStatus: string): string[] {
  const db = getDb();
  // Determine status from the dir path
  const status = dirOrStatus.includes("pending") ? "pending"
    : dirOrStatus.includes("processing") ? "processing"
    : dirOrStatus.includes("done") ? "done"
    : dirOrStatus.includes("failed") ? "failed"
    : dirOrStatus;

  const rows = db.prepare<{ filename: string }, [string]>(
    "SELECT filename FROM jobs WHERE status = ? ORDER BY created_at",
  ).all(status);
  return rows.map((r) => r.filename);
}

export function isDuplicate(sessionId: string): boolean {
  const db = getDb();
  const row = db.prepare<{ cnt: number }, [string]>(
    "SELECT COUNT(*) as cnt FROM jobs WHERE status = 'done' AND type = 'session-mine' AND payload LIKE ?",
  ).get(`%"sessionId":"${sessionId}"%`);
  return row !== null && row.cnt > 0;
}

export function isGitJobProcessed(headSha: string, repoPath: string): boolean {
  const db = getDb();
  const row = db.prepare<{ cnt: number }, [string, string]>(
    "SELECT COUNT(*) as cnt FROM jobs WHERE status = 'done' AND type IN ('git-push', 'git-pull') AND payload LIKE ? AND payload LIKE ?",
  ).get(`%"headSha":"${headSha}"%`, `%"repoPath":"${repoPath}"%`);
  return row !== null && row.cnt > 0;
}

export function stampStarted(filenameOrPath: string): void {
  const db = getDb();
  const filename = basename(filenameOrPath);
  db.prepare("UPDATE jobs SET started_at = ?, status = 'processing' WHERE filename = ?")
    .run(new Date().toISOString(), filename);
}

export function completeJob(filenameOrPath: string, result: JobResult): string {
  const db = getDb();
  const filename = basename(filenameOrPath);
  db.prepare(`
    UPDATE jobs SET
      status = 'done', completed_at = ?, duration_ms = ?,
      transcript_tokens = ?, entries_created = ?,
      input_tokens = ?, output_tokens = ?,
      pipeline_data = ?
    WHERE filename = ?
  `).run(
    new Date().toISOString(), result.durationMs,
    result.transcriptTokens ?? null, result.entriesCreated ?? null,
    result.inputTokens ?? null, result.outputTokens ?? null,
    result.pipeline ? JSON.stringify(result.pipeline) : null,
    filename,
  );
  return filename;
}

export function failJob(filenameOrPath: string, error: string, partialResult?: Partial<JobResult>): string {
  const db = getDb();
  const filename = basename(filenameOrPath);
  db.prepare(`
    UPDATE jobs SET status = 'failed', error = ?, failed_at = ?, pipeline_data = ?
    WHERE filename = ?
  `).run(error, new Date().toISOString(), partialResult?.pipeline ? JSON.stringify(partialResult.pipeline) : null, filename);
  return filename;
}

// ── Helpers ──────────────────────────────────────────────────────────

export function jobTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function enqueueRepoSync(repoPath: string): void {
  const repoName = basename(repoPath);
  const syncJob: RepoSyncJob = {
    type: "repo-sync",
    repoPath,
    cwd: repoPath,
    createdAt: new Date().toISOString(),
  };
  writeJob("", syncJob, `${jobTimestamp()}-sync-${repoName}.json`);
}

// ── Legacy path constants (for backward compat) ─────────────────────

export const JOBS_ROOT = "";
export const PENDING_DIR = "pending";
export const PROCESSING_DIR = "processing";
export const DONE_DIR = "done";
export const FAILED_DIR = "failed";
