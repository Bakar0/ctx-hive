import { getDb } from "../db/connection.ts";
import { StageMetricsSchema, type PipelineExecution, type StageMetrics } from "./schema.ts";

// ── Stage name backward compatibility ────────────────────────────────

/** Maps legacy stage names to their current names. */
const STAGE_NAME_ALIASES: Record<string, string> = {
  scan: "ingest",
  gather: "ingest",
  inject: "prepare",
  mine: "extract",
  analyze: "extract",
  collect: "summarize",
};

/** Returns the canonical stage name, mapping legacy names to current ones. */
export function canonicalStageName(name: string): string {
  return STAGE_NAME_ALIASES[name] ?? name;
}

/** Returns all names to search for a given canonical name (canonical + legacy aliases). */
function allNamesFor(canonical: string): string[] {
  const names = [canonical];
  for (const [old, current] of Object.entries(STAGE_NAME_ALIASES)) {
    if (current === canonical) names.push(old);
  }
  return names;
}

/** Finds a pipeline_messages row by execution ID and stage name (including legacy aliases). */
function findMessageRow(executionId: string, stageName: string): { data: string } | null {
  const db = getDb();
  const names = allNamesFor(stageName);
  const placeholders = names.map(() => "?").join(",");
  return db.prepare<{ data: string }, (string)[]>(
    `SELECT data FROM pipeline_messages WHERE execution_id = ? AND stage_name IN (${placeholders}) LIMIT 1`,
  ).get(executionId, ...names) ?? null;
}

// ── Message I/O ──────────────────────────────────────────────────────

export function writeMessage(
  executionId: string,
  stageName: string,
  data: unknown,
  metrics?: StageMetrics,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO pipeline_messages (execution_id, stage_name, timestamp, data, metrics)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(execution_id, stage_name) DO UPDATE SET
      timestamp = excluded.timestamp, data = excluded.data, metrics = excluded.metrics
  `).run(executionId, stageName, new Date().toISOString(), JSON.stringify(data), metrics ? JSON.stringify(metrics) : null);
}

export function readMessage(executionId: string, stageName: string): unknown {
  const row = findMessageRow(executionId, stageName);
  if (row) return JSON.parse(row.data);
  throw new Error(`Message not found: ${stageName} for execution ${executionId}`);
}

export function messageExists(executionId: string, stageName: string): boolean {
  return findMessageRow(executionId, stageName) !== null;
}

// ── Manifest I/O ─────────────────────────────────────────────────────

export function writeManifest(executionId: string, exec: PipelineExecution): void {
  const db = getDb();

  const tx = db.transaction(() => {
    // Upsert execution
    db.prepare(`
      INSERT INTO pipeline_executions (id, pipeline_name, status, job_id, project, started_at, completed_at,
        total_duration_ms, total_input_tokens, total_output_tokens, total_cost_usd, entries_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, completed_at = excluded.completed_at,
        total_duration_ms = excluded.total_duration_ms, total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens, total_cost_usd = excluded.total_cost_usd,
        entries_created = excluded.entries_created
    `).run(exec.id, exec.pipelineName, exec.status, exec.jobId, exec.project,
      exec.startedAt, exec.completedAt ?? null, exec.totalDurationMs ?? null,
      exec.totalInputTokens ?? null, exec.totalOutputTokens ?? null,
      exec.totalCostUsd ?? null, exec.entriesCreated ?? null);

    // Replace stages (delete + re-insert for simplicity)
    db.prepare("DELETE FROM pipeline_stages WHERE execution_id = ?").run(exec.id);
    const insertStage = db.prepare(`
      INSERT INTO pipeline_stages (execution_id, name, status, started_at, completed_at, duration_ms, retry_count, error, metrics)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const stage of exec.stages) {
      insertStage.run(exec.id, stage.name, stage.status, stage.startedAt ?? null,
        stage.completedAt ?? null, stage.durationMs ?? null, stage.retryCount,
        stage.error ?? null, JSON.stringify(stage.metrics));
    }
  });
  tx();
}

interface ExecutionRow {
  id: string; pipeline_name: string; status: string; job_id: string; project: string;
  started_at: string; completed_at: string | null;
  total_duration_ms: number | null; total_input_tokens: number | null;
  total_output_tokens: number | null; total_cost_usd: number | null; entries_created: number | null;
}

interface StageRow {
  name: string; status: string; started_at: string | null; completed_at: string | null;
  duration_ms: number | null; retry_count: number; error: string | null; metrics: string;
}

const MetricsSchema = StageMetricsSchema.passthrough();

export function readManifest(executionId: string): unknown {
  const db = getDb();

  const exec = db.prepare<ExecutionRow, [string]>(
    "SELECT * FROM pipeline_executions WHERE id = ?",
  ).get(executionId);

  if (!exec) throw new Error(`Execution not found: ${executionId}`);

  const stages = db.prepare<StageRow, [string]>(
    "SELECT * FROM pipeline_stages WHERE execution_id = ? ORDER BY id",
  ).all(executionId);

  return {
    id: exec.id,
    pipelineName: exec.pipeline_name,
    status: exec.status,
    jobId: exec.job_id,
    project: exec.project,
    startedAt: exec.started_at,
    completedAt: exec.completed_at ?? undefined,
    stages: stages.map((s) => ({
      name: s.name,
      status: s.status,
      startedAt: s.started_at ?? undefined,
      completedAt: s.completed_at ?? undefined,
      durationMs: s.duration_ms ?? undefined,
      retryCount: s.retry_count,
      error: s.error ?? undefined,
      metrics: MetricsSchema.parse(JSON.parse(s.metrics)),
    })),
    totalDurationMs: exec.total_duration_ms ?? undefined,
    totalInputTokens: exec.total_input_tokens ?? undefined,
    totalOutputTokens: exec.total_output_tokens ?? undefined,
    totalCostUsd: exec.total_cost_usd ?? undefined,
    entriesCreated: exec.entries_created ?? undefined,
  };
}

// ── List executions ──────────────────────────────────────────────────

export function listExecutionIds(): string[] {
  const db = getDb();
  const rows = db.prepare<{ id: string }, []>("SELECT id FROM pipeline_executions ORDER BY started_at DESC").all();
  return rows.map((r) => r.id);
}

/** Loads all executions with their stages in two queries (instead of N+1). */
export function listExecutions(opts?: {
  project?: string;
  status?: string;
  limit?: number;
}): unknown[] {
  const db = getDb();

  // Build filtered execution query
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts?.project !== undefined) {
    conditions.push("project = ?");
    params.push(opts.project);
  }
  if (opts?.status !== undefined) {
    conditions.push("status = ?");
    params.push(opts.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitClause = opts?.limit !== undefined ? `LIMIT ?` : "";
  if (opts?.limit !== undefined) params.push(opts.limit);

  const execRows = db.prepare<ExecutionRow, (string | number)[]>(
    `SELECT * FROM pipeline_executions ${where} ORDER BY started_at DESC ${limitClause}`,
  ).all(...params);

  if (execRows.length === 0) return [];

  // Batch load all stages for these executions
  const execIds = execRows.map((e) => e.id);
  const placeholders = execIds.map(() => "?").join(",");
  const stageRows = db.prepare<StageRow & { execution_id: string }, string[]>(
    `SELECT execution_id, name, status, started_at, completed_at, duration_ms, retry_count, error, metrics
     FROM pipeline_stages WHERE execution_id IN (${placeholders}) ORDER BY id`,
  ).all(...execIds);

  // Group stages by execution ID
  const stagesByExec = new Map<string, StageRow[]>();
  for (const s of stageRows) {
    const list = stagesByExec.get(s.execution_id) ?? [];
    list.push(s);
    stagesByExec.set(s.execution_id, list);
  }

  return execRows.map((exec) => {
    const stages = stagesByExec.get(exec.id) ?? [];
    return {
      id: exec.id,
      pipelineName: exec.pipeline_name,
      status: exec.status,
      jobId: exec.job_id,
      project: exec.project,
      startedAt: exec.started_at,
      completedAt: exec.completed_at ?? undefined,
      stages: stages.map((s) => ({
        name: s.name,
        status: s.status,
        startedAt: s.started_at ?? undefined,
        completedAt: s.completed_at ?? undefined,
        durationMs: s.duration_ms ?? undefined,
        retryCount: s.retry_count,
        error: s.error ?? undefined,
        metrics: MetricsSchema.parse(JSON.parse(s.metrics)),
      })),
      totalDurationMs: exec.total_duration_ms ?? undefined,
      totalInputTokens: exec.total_input_tokens ?? undefined,
      totalOutputTokens: exec.total_output_tokens ?? undefined,
      totalCostUsd: exec.total_cost_usd ?? undefined,
      entriesCreated: exec.entries_created ?? undefined,
    };
  });
}

// ── Cleanup ──────────────────────────────────────────────────────────

export function cleanupMessages(executionId: string): void {
  const db = getDb();
  // CASCADE will handle stages and messages
  db.prepare("DELETE FROM pipeline_executions WHERE id = ?").run(executionId);
}
