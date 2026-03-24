/**
 * One-time import of existing file-based data into SQLite.
 * Idempotent — checks a 'seeded' flag in schema_meta before running.
 * Does NOT delete source files after import.
 */
import type { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseFrontmatter, SCOPES, hiveRoot } from "../ctx/store.ts";
import { JOB_STATUSES } from "../daemon/jobs.ts";
import { PipelineExecutionSchema, MessageEnvelopeSchema } from "../pipeline/schema.ts";

// ── Types ─────────────────────────────────────────────────────────────

export interface SeedResult {
  skipped: boolean;
  entries: number;
  jobs: number;
  signals: number;
  searchHistory: number;
  repos: number;
  pipelines: number;
}

// ── Main ──────────────────────────────────────────────────────────────

// ── Paths (resolved at call time from hiveRoot()) ────────────────────

function seedPaths() {
  const root = hiveRoot();
  return {
    entries: join(root, "entries"),
    jobs: join(root, "jobs"),
    signals: join(root, "signals.json"),
    history: join(root, "search-history.jsonl"),
    repos: join(root, "repos.json"),
    messages: join(root, "messages"),
  };
}

export async function seedFromFiles(db: Database): Promise<SeedResult> {
  const result: SeedResult = { skipped: false, entries: 0, jobs: 0, signals: 0, searchHistory: 0, repos: 0, pipelines: 0 };

  const seeded = db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='seeded'").get();
  if (seeded) {
    result.skipped = true;
    return result;
  }

  result.entries = await seedEntries(db);
  result.jobs = await seedJobs(db);
  result.signals = await seedSignals(db);
  result.searchHistory = await seedSearchHistory(db);
  result.repos = await seedRepos(db);
  result.pipelines = await seedPipelines(db);

  db.exec("INSERT INTO schema_meta (key, value) VALUES ('seeded', 'true')");

  return result;
}

// ── Entries ───────────────────────────────────────────────────────────

interface SeedEntryRow {
  id: string; title: string; slug: string; scope: string;
  tags: string; project: string; body: string; tokens: number;
  createdAt: string; updatedAt: string;
}

async function seedEntries(db: Database): Promise<number> {
  const rows: SeedEntryRow[] = [];

  const paths = seedPaths();
  for (const scope of SCOPES) {
    const scopeDir = join(paths.entries, scope);
    let files: string[];
    try {
      files = await readdir(scopeDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const slug = file.replace(/\.md$/, "");
      try {
        const raw = await Bun.file(join(scopeDir, file)).text();
        const { meta, body } = parseFrontmatter(raw);
        rows.push({
          id: meta.id, title: meta.title, slug, scope,
          tags: JSON.stringify(meta.tags), project: meta.project,
          body, tokens: meta.tokens, createdAt: meta.created, updatedAt: meta.updated,
        });
      } catch {
        // Skip malformed entries
      }
    }
  }

  if (rows.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO entries (id, title, slug, scope, tags, project, body, tokens, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      insert.run(r.id, r.title, r.slug, r.scope, r.tags, r.project, r.body, r.tokens, r.createdAt, r.updatedAt);
    }
  });
  tx();
  return rows.length;
}

// ── Jobs ──────────────────────────────────────────────────────────────

interface SeedJobRow {
  filename: string; type: string; status: string; payload: string;
  error: string | null; createdAt: string; startedAt: string | null;
  completedAt: string | null; failedAt: string | null;
  durationMs: number | null; transcriptTokens: number | null;
  entriesCreated: number | null; inputTokens: number | null;
  outputTokens: number | null; pipelineData: string | null;
}

async function seedJobs(db: Database): Promise<number> {
  const rows: SeedJobRow[] = [];

  const paths = seedPaths();
  for (const status of JOB_STATUSES) {
    const dir = join(paths.jobs, status);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await Bun.file(join(dir, file)).text();
        const data = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
        const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
        const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
        rows.push({
          filename: file,
          type: typeof data.type === "string" ? data.type : "unknown",
          status,
          payload: raw,
          error: str(data.error),
          createdAt: typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
          startedAt: str(data.startedAt),
          completedAt: str(data.completedAt),
          failedAt: str(data.failedAt),
          durationMs: num(data.durationMs),
          transcriptTokens: num(data.transcriptTokens),
          entriesCreated: num(data.entriesCreated),
          inputTokens: num(data.inputTokens),
          outputTokens: num(data.outputTokens),
          pipelineData: data.pipeline != null ? JSON.stringify(data.pipeline) : null,
        });
      } catch {
        // Skip malformed job files
      }
    }
  }

  if (rows.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO jobs (filename, type, status, payload, error, created_at, started_at, completed_at, failed_at,
      duration_ms, transcript_tokens, entries_created, input_tokens, output_tokens, pipeline_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      insert.run(r.filename, r.type, r.status, r.payload, r.error, r.createdAt, r.startedAt, r.completedAt, r.failedAt,
        r.durationMs, r.transcriptTokens, r.entriesCreated, r.inputTokens, r.outputTokens, r.pipelineData);
    }
  });
  tx();
  return rows.length;
}

// ── Signals ──────────────────────────────────────────────────────────

async function seedSignals(db: Database): Promise<number> {
  const file = Bun.file(seedPaths().signals);
  if (!(await file.exists())) return 0;

  const RawSignalsSchema = z.object({
    entries: z.record(z.string(), z.object({
      searchHits: z.array(z.object({ date: z.string(), count: z.number() })).optional(),
      evaluations: z.array(z.object({
        evaluatedAt: z.string(), sessionId: z.string(), rating: z.number(), reason: z.string().optional(),
      })).optional(),
    })).optional(),
  });

  let store: z.infer<typeof RawSignalsSchema>;
  try {
    store = RawSignalsSchema.parse(JSON.parse(await file.text()));
  } catch {
    return 0;
  }
  if (!store.entries) return 0;

  const insertHit = db.prepare("INSERT OR IGNORE INTO signal_hits (entry_id, date, count) VALUES (?, ?, ?)");
  const insertEval = db.prepare(
    "INSERT INTO signal_evaluations (entry_id, session_id, rating, reason, evaluated_at) VALUES (?, ?, ?, ?, ?)",
  );

  let count = 0;
  const tx = db.transaction(() => {
    for (const [entryId, signals] of Object.entries(store.entries!)) {
      if (signals.searchHits) {
        for (const bucket of signals.searchHits) {
          insertHit.run(entryId, bucket.date, bucket.count);
          count++;
        }
      }
      if (signals.evaluations) {
        for (const ev of signals.evaluations) {
          insertEval.run(entryId, ev.sessionId, ev.rating, ev.reason ?? null, ev.evaluatedAt);
          count++;
        }
      }
    }
  });

  tx();
  return count;
}

// ── Search History ───────────────────────────────────────────────────

async function seedSearchHistory(db: Database): Promise<number> {
  const file = Bun.file(seedPaths().history);
  if (!(await file.exists())) return 0;

  const text = await file.text();
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return 0;

  const insertHistory = db.prepare(`
    INSERT INTO search_history (timestamp, source, query, project, cwd, session_id, result_count, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertResult = db.prepare(
    "INSERT INTO search_results (history_id, entry_id, title, score, tokens) VALUES (?, ?, ?, ?, ?)",
  );
  const getLastId = db.prepare<{ id: number }, []>("SELECT last_insert_rowid() as id");

  let count = 0;
  const tx = db.transaction(() => {
    for (const line of lines) {
      try {
        const SearchRecordLineSchema = z.object({
          timestamp: z.string(), source: z.string(), query: z.string(),
          project: z.string().optional(), cwd: z.string().optional(), sessionId: z.string().optional(),
          resultCount: z.number(), durationMs: z.number(),
          results: z.array(z.object({ id: z.string(), title: z.string(), score: z.number(), tokens: z.number() })),
        });
        const r = SearchRecordLineSchema.parse(JSON.parse(line));

        insertHistory.run(r.timestamp, r.source, r.query, r.project ?? null, r.cwd ?? null,
          r.sessionId ?? null, r.resultCount, r.durationMs);

        const row = getLastId.get()!;

        for (const res of r.results) {
          insertResult.run(row.id, res.id, res.title, res.score, res.tokens);
        }
        count++;
      } catch {
        // Skip malformed lines
      }
    }
  });

  tx();
  return count;
}

// ── Tracked Repos ────────────────────────────────────────────────────

async function seedRepos(db: Database): Promise<number> {
  const file = Bun.file(seedPaths().repos);
  if (!(await file.exists())) return 0;

  const RawRepoStoreSchema = z.object({
    repos: z.array(z.object({
      name: z.string(), absPath: z.string(), org: z.string(),
      remoteUrl: z.string(), trackedAt: z.string(), lastScannedAt: z.string().optional(),
    })).optional(),
  });

  let data: z.infer<typeof RawRepoStoreSchema>;
  try {
    data = RawRepoStoreSchema.parse(JSON.parse(await file.text()));
  } catch {
    return 0;
  }
  if (!data.repos || data.repos.length === 0) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO tracked_repos (name, abs_path, org, remote_url, tracked_at, last_scanned_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const repo of data.repos!) {
      insert.run(repo.name, repo.absPath, repo.org, repo.remoteUrl, repo.trackedAt, repo.lastScannedAt ?? null);
    }
  });

  tx();
  return data.repos.length;
}

// ── Pipeline Executions ──────────────────────────────────────────────

async function seedPipelines(db: Database): Promise<number> {
  const messagesDir = seedPaths().messages;
  let executionIds: string[];
  try {
    const dirEntries = await readdir(messagesDir, { withFileTypes: true });
    executionIds = dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return 0;
  }
  if (executionIds.length === 0) return 0;

  const insertExec = db.prepare(`
    INSERT OR IGNORE INTO pipeline_executions
      (id, pipeline_name, status, job_filename, project, started_at, completed_at,
       total_duration_ms, total_input_tokens, total_output_tokens, total_cost_usd, entries_created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertStage = db.prepare(`
    INSERT INTO pipeline_stages (execution_id, name, status, started_at, completed_at, duration_ms, retry_count, error, metrics)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO pipeline_messages (execution_id, stage_name, timestamp, data, metrics)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;

  for (const executionId of executionIds) {
    const manifestFile = Bun.file(join(messagesDir, executionId, "manifest.json"));
    if (!(await manifestFile.exists())) continue;

    try {
      const exec = PipelineExecutionSchema.parse(JSON.parse(await manifestFile.text()));

      const execTx = db.transaction(() => {
        insertExec.run(exec.id, exec.pipelineName, exec.status, exec.jobFilename, exec.project,
          exec.startedAt, exec.completedAt ?? null, exec.totalDurationMs ?? null,
          exec.totalInputTokens ?? null, exec.totalOutputTokens ?? null,
          exec.totalCostUsd ?? null, exec.entriesCreated ?? null);

        for (const stage of exec.stages) {
          insertStage.run(exec.id, stage.name, stage.status, stage.startedAt ?? null,
            stage.completedAt ?? null, stage.durationMs ?? null, stage.retryCount,
            stage.error ?? null, JSON.stringify(stage.metrics));
        }
      });
      execTx();
      count++;

      // Seed stage messages
      const execDir = join(messagesDir, executionId);
      const msgFiles = await readdir(execDir).catch(() => [] as string[]);
      const msgRows: { stageName: string; timestamp: string; data: string; metrics: string | null }[] = [];

      for (const file of msgFiles) {
        if (!file.endsWith(".out.json")) continue;
        const stageName = file.replace(/\.out\.json$/, "");
        try {
          const raw = await Bun.file(join(execDir, file)).text();
          const envelope = MessageEnvelopeSchema.parse(JSON.parse(raw));
          msgRows.push({
            stageName,
            timestamp: envelope.timestamp,
            data: JSON.stringify(envelope.data),
            metrics: envelope.metrics ? JSON.stringify(envelope.metrics) : null,
          });
        } catch {
          // Skip malformed messages
        }
      }

      if (msgRows.length > 0) {
        const msgTx = db.transaction(() => {
          for (const m of msgRows) {
            insertMessage.run(executionId, m.stageName, m.timestamp, m.data, m.metrics);
          }
        });
        msgTx();
      }
    } catch {
      // Skip malformed manifests
    }
  }

  return count;
}
