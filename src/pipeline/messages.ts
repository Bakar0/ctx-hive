import { z } from "zod";
import { getDb } from "../db/connection.ts";
import type { PipelineExecution, StageMetrics } from "./schema.ts";

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

/** Returns all legacy names that map to the given canonical name. */
function legacyNamesFor(canonical: string): string[] {
  const names: string[] = [];
  for (const [old, current] of Object.entries(STAGE_NAME_ALIASES)) {
    if (current === canonical) names.push(old);
  }
  return names;
}

// ── No-op legacy exports ─────────────────────────────────────────────

export function messagesRoot(): string {
  return "";
}

export function executionDir(_executionId: string): string {
  return "";
}

export function ensureMessageDirs(): void {
  // No-op — DB handles storage
}

export function createExecutionDir(_executionId: string): string {
  // No-op — execution is created via writeManifest
  return "";
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
  const db = getDb();

  // Try canonical name first
  const row = db.prepare<{ data: string }, [string, string]>(
    "SELECT data FROM pipeline_messages WHERE execution_id = ? AND stage_name = ?",
  ).get(executionId, stageName);

  if (row) return JSON.parse(row.data);

  // Fallback: try legacy stage names
  for (const legacy of legacyNamesFor(stageName)) {
    const legacyRow = db.prepare<{ data: string }, [string, string]>(
      "SELECT data FROM pipeline_messages WHERE execution_id = ? AND stage_name = ?",
    ).get(executionId, legacy);
    if (legacyRow) return JSON.parse(legacyRow.data);
  }

  throw new Error(`Message not found: ${stageName} for execution ${executionId}`);
}

export function messageExists(executionId: string, stageName: string): boolean {
  const db = getDb();
  const row = db.prepare<{ cnt: number }, [string, string]>(
    "SELECT COUNT(*) as cnt FROM pipeline_messages WHERE execution_id = ? AND stage_name = ?",
  ).get(executionId, stageName);
  if (row !== null && row.cnt > 0) return true;

  // Check legacy names
  for (const legacy of legacyNamesFor(stageName)) {
    const legacyRow = db.prepare<{ cnt: number }, [string, string]>(
      "SELECT COUNT(*) as cnt FROM pipeline_messages WHERE execution_id = ? AND stage_name = ?",
    ).get(executionId, legacy);
    if (legacyRow !== null && legacyRow.cnt > 0) return true;
  }
  return false;
}

// ── Manifest I/O ─────────────────────────────────────────────────────

export function writeManifest(executionId: string, manifest: PipelineExecution): void {
  const exec = manifest;
  const db = getDb();

  const tx = db.transaction(() => {
    // Upsert execution
    db.prepare(`
      INSERT INTO pipeline_executions (id, pipeline_name, status, job_filename, project, started_at, completed_at,
        total_duration_ms, total_input_tokens, total_output_tokens, total_cost_usd, entries_created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, completed_at = excluded.completed_at,
        total_duration_ms = excluded.total_duration_ms, total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens, total_cost_usd = excluded.total_cost_usd,
        entries_created = excluded.entries_created
    `).run(exec.id, exec.pipelineName, exec.status, exec.jobFilename, exec.project,
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
  id: string; pipeline_name: string; status: string; job_filename: string; project: string;
  started_at: string; completed_at: string | null;
  total_duration_ms: number | null; total_input_tokens: number | null;
  total_output_tokens: number | null; total_cost_usd: number | null; entries_created: number | null;
}

interface StageRow {
  name: string; status: string; started_at: string | null; completed_at: string | null;
  duration_ms: number | null; retry_count: number; error: string | null; metrics: string;
}

const MetricsSchema = z.record(z.string(), z.unknown());

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
    jobFilename: exec.job_filename,
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

// ── Cleanup ──────────────────────────────────────────────────────────

export function cleanupMessages(executionId: string): void {
  const db = getDb();
  // CASCADE will handle stages and messages
  db.prepare("DELETE FROM pipeline_executions WHERE id = ?").run(executionId);
}
