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

// ── Job I/O ──────────────────────────────────────────────────────────

export function readJob(jobId: string): Job {
  const db = getDb();
  const row = db.prepare<{ payload: string }, [string]>("SELECT payload FROM jobs WHERE job_id = ?").get(jobId);
  if (!row) throw new Error(`Job not found: ${jobId}`);
  return JobSchema.parse(JSON.parse(row.payload));
}

export function writeJob(job: Job, jobId: string): string {
  const db = getDb();
  db.prepare(`
    INSERT INTO jobs (job_id, type, status, payload, created_at)
    VALUES (?, ?, 'pending', ?, ?)
  `).run(jobId, job.type, JSON.stringify(job), job.createdAt);
  return jobId;
}

export function listJobs(status: JobStatus): string[] {
  const db = getDb();
  const rows = db.prepare<{ job_id: string }, [string]>(
    "SELECT job_id FROM jobs WHERE status = ? ORDER BY created_at",
  ).all(status);
  return rows.map((r) => r.job_id);
}

export function isDuplicate(sessionId: string): boolean {
  const db = getDb();
  const row = db.prepare<{ cnt: number }, [string]>(
    "SELECT COUNT(*) as cnt FROM jobs WHERE status = 'done' AND type = 'session-mine' AND json_extract(payload, '$.sessionId') = ?",
  ).get(sessionId);
  return row !== null && row.cnt > 0;
}

export function isGitJobProcessed(headSha: string, repoPath: string): boolean {
  const db = getDb();
  const row = db.prepare<{ cnt: number }, [string, string]>(
    "SELECT COUNT(*) as cnt FROM jobs WHERE status = 'done' AND type IN ('git-push', 'git-pull') AND json_extract(payload, '$.headSha') = ? AND json_extract(payload, '$.repoPath') = ?",
  ).get(headSha, repoPath);
  return row !== null && row.cnt > 0;
}

export function stampStarted(jobId: string): void {
  const db = getDb();
  db.prepare("UPDATE jobs SET started_at = ?, status = 'processing' WHERE job_id = ?")
    .run(new Date().toISOString(), jobId);
}

export function completeJob(jobId: string, result: JobResult): string {
  const db = getDb();
  db.prepare(`
    UPDATE jobs SET
      status = 'done', completed_at = ?, duration_ms = ?,
      transcript_tokens = ?, entries_created = ?,
      input_tokens = ?, output_tokens = ?,
      pipeline_data = ?
    WHERE job_id = ?
  `).run(
    new Date().toISOString(), result.durationMs,
    result.transcriptTokens ?? null, result.entriesCreated ?? null,
    result.inputTokens ?? null, result.outputTokens ?? null,
    result.pipeline ? JSON.stringify(result.pipeline) : null,
    jobId,
  );
  return jobId;
}

export function failJob(jobId: string, error: string, partialResult?: Partial<JobResult>): string {
  const db = getDb();
  db.prepare(`
    UPDATE jobs SET status = 'failed', error = ?, failed_at = ?, pipeline_data = ?
    WHERE job_id = ?
  `).run(error, new Date().toISOString(), partialResult?.pipeline ? JSON.stringify(partialResult.pipeline) : null, jobId);
  return jobId;
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
  writeJob(syncJob, `${jobTimestamp()}-sync-${repoName}`);
}
