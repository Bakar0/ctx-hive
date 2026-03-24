import {
  type PipelineDef,
  type PipelineExecution,
  type StageExecution,
  type StageContext,
  type StageDef,
  type ExecutorOptions,
  PipelineExecutionSchema,
} from "./schema.ts";
import {
  writeMessage,
  writeManifest,
  readManifest,
} from "./messages.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function newStageExecution(name: string): StageExecution {
  return {
    name,
    status: "pending",
    retryCount: 0,
    metrics: {},
  };
}

function aggregateMetrics(stages: StageExecution[]): {
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
} {
  let totalDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  for (const s of stages) {
    totalDurationMs += s.durationMs ?? 0;
    totalInputTokens += s.metrics.inputTokens ?? 0;
    totalOutputTokens += s.metrics.outputTokens ?? 0;
    totalCostUsd += s.metrics.costUsd ?? 0;
  }

  return { totalDurationMs, totalInputTokens, totalOutputTokens, totalCostUsd };
}

// ── Stage runner (with retries) ──────────────────────────────────────

async function runStage(
  stage: StageDef,
  input: unknown,
  execution: PipelineExecution,
  stageExec: StageExecution,
  options: ExecutorOptions,
): Promise<unknown> {
  const maxRetries = stage.retries ?? 0;
  const baseDelay = stage.retryDelayMs ?? 5_000;

  // Check skip condition
  if (stage.condition !== undefined && !stage.condition(input)) {
    stageExec.status = "skipped";
    stageExec.completedAt = new Date().toISOString();
    options.onStageChange?.(stageExec);
    writeManifest(execution.id, execution);
    return input; // pass through
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    stageExec.status = "running";
    stageExec.startedAt = new Date().toISOString();
    stageExec.retryCount = attempt;
    options.onStageChange?.(stageExec);
    writeManifest(execution.id, execution);

    const startMs = Date.now();

    try {
      const ctx: StageContext = {
        executionId: execution.id,
        pipelineName: execution.pipelineName,
        stageName: stage.name,
        setMetrics: (metrics) => Object.assign(stageExec.metrics, metrics),
        signal: options.signal ?? AbortSignal.timeout(600_000),
      };

      const output = await stage.run(input, ctx);

      stageExec.durationMs = Date.now() - startMs;
      stageExec.status = "completed";
      stageExec.completedAt = new Date().toISOString();
      stageExec.error = undefined;

      // Write output message to disk
      writeMessage(execution.id, stage.name, output, stageExec.metrics);
      options.onStageChange?.(stageExec);
      writeManifest(execution.id, execution);

      return output;
    } catch (err) {
      stageExec.durationMs = Date.now() - startMs;
      stageExec.error = String(err);

      if (attempt < maxRetries) {
        // Exponential backoff with jitter
        const delay = baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 0.2 * delay;
        await Bun.sleep(delay + jitter);
      } else {
        stageExec.status = "failed";
        stageExec.completedAt = new Date().toISOString();
        options.onStageChange?.(stageExec);
        writeManifest(execution.id, execution);
        throw err;
      }
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error(`Stage ${stage.name} failed after ${maxRetries + 1} attempts`);
}

// ── Pipeline executor ────────────────────────────────────────────────

export async function executePipeline(
  def: PipelineDef,
  initialInput: unknown,
  options: ExecutorOptions,
): Promise<PipelineExecution> {
  const executionId = crypto.randomUUID();

  // Initialize execution record
  const allStageNames: string[] = [];
  for (const step of def.steps) {
    if (step.type === "serial") {
      allStageNames.push(step.stage.name);
    } else {
      for (const s of step.stages) {
        allStageNames.push(s.name);
      }
    }
  }

  const execution: PipelineExecution = {
    id: executionId,
    pipelineName: def.name,
    status: "running",
    jobFilename: options.jobFilename,
    project: options.project,
    startedAt: new Date().toISOString(),
    stages: allStageNames.map(newStageExecution),
  };

  // Write manifest first (creates execution row), then initial input
  writeManifest(executionId, execution);
  writeMessage(executionId, "_input", initialInput);

  // Notify that pipeline has started with all stages visible
  options.onPipelineStart?.(execution);

  const pipelineStart = Date.now();
  let currentInput: unknown = initialInput;

  try {
    for (const step of def.steps) {
      if (step.type === "serial") {
        const stageExec = execution.stages.find((s) => s.name === step.stage.name);
        if (stageExec === undefined) throw new Error(`Stage ${step.stage.name} not found in execution`);
        currentInput = await runStage(step.stage, currentInput, execution, stageExec, options);
      } else {
        // Parallel: all stages receive the same input, run concurrently
        const results = await Promise.allSettled(
          step.stages.map((stage) => {
            const stageExec = execution.stages.find((s) => s.name === stage.name);
            if (stageExec === undefined) throw new Error(`Stage ${stage.name} not found in execution`);
            return runStage(stage, currentInput, execution, stageExec, options);
          }),
        );

        // Merge parallel outputs keyed by stage name
        const merged: Record<string, unknown> = {};
        for (let i = 0; i < step.stages.length; i++) {
          const result = results[i]!;
          const stageName = step.stages[i]!.name;
          if (result.status === "fulfilled") {
            merged[stageName] = result.value;
          } else {
            // Stage already marked as failed in runStage, re-throw to fail pipeline
            throw result.reason;
          }
        }
        currentInput = merged;
      }
    }

    // Pipeline completed successfully
    execution.status = "completed";
    execution.completedAt = new Date().toISOString();
    execution.totalDurationMs = Date.now() - pipelineStart;

    const agg = aggregateMetrics(execution.stages);
    execution.totalInputTokens = agg.totalInputTokens;
    execution.totalOutputTokens = agg.totalOutputTokens;
    execution.totalCostUsd = agg.totalCostUsd;

    writeManifest(executionId, execution);
    return execution;
  } catch (err) {
    // Pipeline failed
    execution.status = "failed";
    execution.completedAt = new Date().toISOString();
    execution.totalDurationMs = Date.now() - pipelineStart;

    const agg = aggregateMetrics(execution.stages);
    execution.totalInputTokens = agg.totalInputTokens;
    execution.totalOutputTokens = agg.totalOutputTokens;
    execution.totalCostUsd = agg.totalCostUsd;

    writeManifest(executionId, execution);
    throw err;
  }
}

// ── Read execution from manifest ─────────────────────────────────────

export function loadExecution(executionId: string): PipelineExecution {
  const manifest = readManifest(executionId);
  return PipelineExecutionSchema.parse(manifest);
}
