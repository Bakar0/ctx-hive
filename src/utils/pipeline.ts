import { spawnClaude, type SpawnClaudeOptions } from "../adapter/claude.ts";

export interface PipelineTask<T> {
  name: string;
  options: SpawnClaudeOptions;
  parse?: (result: string) => T;
}

export interface PipelineResult<T> {
  name: string;
  data?: T;
  resultText?: string;
  logPath: string;
  error?: string;
  cost_usd: number;
  duration_ms: number;
}

export interface PhaseSummary<T> {
  results: PipelineResult<T>[];
  total_cost_usd: number;
  total_duration_ms: number;
}

export async function runParallel<T>(tasks: PipelineTask<T>[]): Promise<PhaseSummary<T>> {
  const startTime = Date.now();

  const instances = await Promise.all(
    tasks.map((task) => spawnClaude(task.options)),
  );

  const settled = await Promise.all(
    instances.map(async (instance, i) => {
      const task = tasks[i]!;
      try {
        const { exitCode, result } = await instance.completed;
        if (exitCode !== 0 || !result) {
          return {
            name: task.name,
            logPath: instance.logPath,
            error: `Agent '${task.name}' exited with code ${exitCode}`,
            cost_usd: result?.total_cost_usd ?? 0,
            duration_ms: result?.duration_ms ?? 0,
          } satisfies PipelineResult<T>;
        }

        const data = task.parse ? task.parse(result.result) : undefined;
        return {
          name: task.name,
          resultText: result.result,
          logPath: instance.logPath,
          data,
          cost_usd: result.total_cost_usd,
          duration_ms: result.duration_ms,
        } satisfies PipelineResult<T>;
      } catch (err) {
        return {
          name: task.name,
          logPath: instance.logPath,
          error: `Agent '${task.name}' failed: ${err}`,
          cost_usd: 0,
          duration_ms: 0,
        } satisfies PipelineResult<T>;
      }
    }),
  );

  return {
    results: settled,
    total_cost_usd: settled.reduce((sum, r) => sum + r.cost_usd, 0),
    total_duration_ms: Date.now() - startTime,
  };
}

export async function runSingle<T>(task: PipelineTask<T>): Promise<PhaseSummary<T>> {
  return runParallel([task]);
}
