import { z } from "zod";

// ── Stage status ─────────────────────────────────────────────────────

export const StageStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

// ── Stage metrics ────────────────────────────────────────────────────

export const StageMetricsSchema = z.object({
  itemsProcessed: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
});
export type StageMetrics = z.infer<typeof StageMetricsSchema>;

// ── Stage execution record (persisted in manifest) ───────────────────

export const StageExecutionSchema = z.object({
  name: z.string(),
  status: StageStatusSchema,
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  retryCount: z.number(),
  error: z.string().optional(),
  metrics: StageMetricsSchema,
});
export type StageExecution = z.infer<typeof StageExecutionSchema>;

// ── Pipeline execution record (persisted in manifest) ────────────────

export const PipelineStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

export const PipelineExecutionSchema = z.object({
  id: z.string(),
  pipelineName: z.string(),
  status: PipelineStatusSchema,
  jobId: z.string(),
  project: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  stages: z.array(StageExecutionSchema),
  totalDurationMs: z.number().optional(),
  totalInputTokens: z.number().optional(),
  totalOutputTokens: z.number().optional(),
  totalCostUsd: z.number().optional(),
  entriesCreated: z.number().optional(),
});
export type PipelineExecution = z.infer<typeof PipelineExecutionSchema>;

// ── Message envelope (written to disk between stages) ────────────────

export const MessageEnvelopeSchema = z.object({
  timestamp: z.string(),
  stageName: z.string(),
  data: z.unknown(),
  metrics: StageMetricsSchema.optional(),
});
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

// ── Stage context (provided to each stage's run function) ────────────

export interface StageContext {
  executionId: string;
  pipelineName: string;
  stageName: string;
  setMetrics: (metrics: Partial<StageMetrics>) => void;
  signal: AbortSignal;
}

// ── Stage definition (compile-time) ──────────────────────────────────

export interface StageDef<TIn = unknown, TOut = unknown> {
  name: string;
  run(input: TIn, ctx: StageContext): Promise<TOut>;
  retries?: number;
  retryDelayMs?: number;
  condition?(input: TIn): boolean;
}

// ── Pipeline topology ────────────────────────────────────────────────

export type PipelineStep =
  | { type: "serial"; stage: StageDef }
  | { type: "parallel"; stages: StageDef[] };

export interface PipelineDef {
  name: string;
  steps: PipelineStep[];
}

// ── Executor options ─────────────────────────────────────────────────

export interface ExecutorOptions {
  jobId: string;
  project: string;
  onPipelineStart?: (execution: PipelineExecution) => void;
  onStageChange?: (stage: StageExecution) => void;
  signal?: AbortSignal;
}
