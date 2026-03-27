import { basename } from "node:path";
import { z } from "zod";
import { executePipeline } from "../pipeline/executor.ts";
import { readMessage, writeManifest } from "../pipeline/messages.ts";
import { sessionMinePipeline, gitPushPipeline, gitPullPipeline, repoSyncPipeline } from "../pipeline/definitions.ts";
import { broadcastPipelineEvent } from "./ws.ts";
import type { Job, JobResult } from "./jobs.ts";
import type { PipelineExecution } from "../pipeline/schema.ts";

const StageOutputSchema = z.object({
  entriesCreated: z.number().optional(),
  transcriptTokens: z.number().optional(),
}).passthrough();

// ── Transcript parsing (kept for backfill-tokens.ts) ─────────────────

export async function extractTranscriptTokens(transcriptPath: string): Promise<number | undefined> {
  try {
    const text = await Bun.file(transcriptPath).text();
    const lines = text.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg: unknown = JSON.parse(lines[i]!);
        if (
          typeof msg !== "object" || msg === null ||
          !("type" in msg) || msg.type !== "assistant" ||
          !("message" in msg) || typeof msg.message !== "object" || msg.message === null ||
          !("usage" in msg.message) || typeof msg.message.usage !== "object" || msg.message.usage === null
        ) continue;
        const u = msg.message.usage;
        const inp = "input_tokens" in u && typeof u.input_tokens === "number" ? u.input_tokens : 0;
        const cacheCreate = "cache_creation_input_tokens" in u && typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
        const cacheRead = "cache_read_input_tokens" in u && typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
        return inp + cacheCreate + cacheRead;
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // skip if unreadable
  }
  return undefined;
}

// ── Handler type ──────────────────────────────────────────────────────

export interface HandlerContext {
  jobId: string;
  signal: AbortSignal;
}

export type JobHandler = (job: Job, ctx: HandlerContext) => Promise<JobResult>;

// ── Handler registry ──────────────────────────────────────────────────

const handlers = new Map<string, JobHandler>();

export function registerHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

// ── Helper: project name from cwd ────────────────────────────────────

function projectFromPath(path?: string): string {
  if (path === undefined || path === "") return "unknown";
  return basename(path);
}

// ── Helper: build job result from pipeline execution ─────────────────

function buildJobResult(execution: PipelineExecution, extra: Partial<JobResult> = {}): JobResult {
  return {
    success: execution.status === "completed",
    error: execution.status === "failed"
      ? execution.stages.find((s) => s.status === "failed")?.error
      : undefined,
    durationMs: execution.totalDurationMs ?? 0,
    entriesCreated: execution.entriesCreated ?? 0,
    inputTokens: execution.totalInputTokens,
    outputTokens: execution.totalOutputTokens,
    pipeline: execution,
    ...extra,
  };
}

// ── Helper: pipeline callbacks factory ────────────────────────────────

function buildPipelineCallbacks(pipelineName: string) {
  return {
    onPipelineStart: (exec: PipelineExecution) => broadcastPipelineEvent("pipeline:started", {
      executionId: exec.id,
      pipelineName,
    }),
    onStageChange: (stage: PipelineExecution["stages"][number]) => broadcastPipelineEvent("pipeline:stage-changed", {
      executionId: "",
      pipelineName,
      stage,
    }),
  };
}

// ── Helper: persist entries count from summarize stage ────────────────

function persistEntriesCount(execution: PipelineExecution): void {
  try {
    const summarizeOutput = StageOutputSchema.parse(readMessage(execution.id, "summarize"));
    execution.entriesCreated = summarizeOutput.entriesCreated ?? 0;
    writeManifest(execution.id, execution);
  } catch {
    // summarize stage may have been skipped
  }
}

// ── Session-mine handler ──────────────────────────────────────────────

async function handleSessionMine(job: Job, ctx: HandlerContext): Promise<JobResult> {
  if (job.type !== "session-mine") throw new Error("Expected session-mine job");

  const execution = await executePipeline(sessionMinePipeline, {
    cwd: job.cwd,
    transcriptPath: job.transcriptPath,
    sessionId: job.sessionId,
  }, {
    jobId: ctx.jobId,
    project: projectFromPath(job.cwd),
    signal: ctx.signal,
    ...buildPipelineCallbacks("session-mine"),
  });

  persistEntriesCount(execution);

  return buildJobResult(execution, {
    transcriptTokens: await extractTranscriptTokens(job.transcriptPath),
  });
}

// ── Git change handler ───────────────────────────────────────────────

async function handleGitChange(job: Job, ctx: HandlerContext): Promise<JobResult> {
  if (job.type !== "git-push" && job.type !== "git-pull") throw new Error("Expected git job");

  const pipeline = job.type === "git-push" ? gitPushPipeline : gitPullPipeline;
  const trigger = job.type === "git-push" ? "push" as const
    : ("trigger" in job && job.trigger === "rebase" ? "pull-rebase" as const : "pull-merge" as const);

  const execution = await executePipeline(pipeline, {
    type: job.type,
    repoPath: job.repoPath,
    headSha: job.headSha,
    trigger,
    refs: job.type === "git-push" ? job.refs : undefined,
  }, {
    jobId: ctx.jobId,
    project: projectFromPath(job.repoPath),
    signal: ctx.signal,
    ...buildPipelineCallbacks(job.type),
  });

  persistEntriesCount(execution);

  return buildJobResult(execution);
}

// ── Repo sync handler ────────────────────────────────────────────────

async function handleRepoSync(job: Job, ctx: HandlerContext): Promise<JobResult> {
  if (job.type !== "repo-sync") throw new Error("Expected repo-sync job");

  const execution = await executePipeline(repoSyncPipeline, {
    repoPath: job.repoPath,
  }, {
    jobId: ctx.jobId,
    project: projectFromPath(job.repoPath),
    signal: ctx.signal,
    ...buildPipelineCallbacks("repo-sync"),
  });

  persistEntriesCount(execution);

  return buildJobResult(execution);
}

// ── Register built-in handlers ────────────────────────────────────────

registerHandler("session-mine", handleSessionMine);
registerHandler("git-push", handleGitChange);
registerHandler("git-pull", handleGitChange);
registerHandler("repo-sync", handleRepoSync);
