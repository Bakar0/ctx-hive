/**
 * Search and injection event log backed by SQLite.
 */
import { z } from "zod";
import { getDb } from "../db/connection.ts";

// ── Types ──────────────────────────────────────────────────────────────

export type SearchSource = "inject" | "cli" | "api";

export interface SearchRecord {
  timestamp: string;
  source: SearchSource;
  query: string;
  project?: string;
  cwd?: string;
  sessionId?: string;
  resultCount: number;
  results: { id: string; title: string; score: number; tokens: number; algorithm?: string }[];
  durationMs: number;
  ftsDurationMs?: number;
  vectorDurationMs?: number;
}

export interface SearchStats {
  totalQueries: number;
  bySource: Record<string, number>;
  zeroResultQueries: number;
  avgResultCount: number;
  topServedEntries: { id: string; title: string; count: number }[];
  avgScoreOfServed: number;
}

// ── Append ─────────────────────────────────────────────────────────────

export function appendSearchRecord(record: SearchRecord): void {
  const db = getDb();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO search_history (timestamp, source, query, project, cwd, session_id, result_count, duration_ms, fts_duration_ms, vector_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.timestamp, record.source, record.query, record.project ?? null,
      record.cwd ?? null, record.sessionId ?? null, record.resultCount, record.durationMs,
      record.ftsDurationMs ?? null, record.vectorDurationMs ?? null,
    );

    const { id: historyId } = db.prepare<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;

    const insertResult = db.prepare(
      "INSERT INTO search_results (history_id, entry_id, title, score, tokens, algorithm) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const r of record.results) {
      insertResult.run(historyId, r.id, r.title, r.score, r.tokens, r.algorithm ?? "fts5");
    }
  });
  tx();
}

// ── Load ───────────────────────────────────────────────────────────────

export function loadSearchHistory(opts?: {
  since?: Date;
  limit?: number;
}): SearchRecord[] {
  const db = getDb();

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts?.since) {
    conditions.push("h.timestamp >= ?");
    params.push(opts.since.toISOString());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let limitClause = "";
  if (opts?.limit !== undefined && opts.limit > 0) {
    limitClause = `LIMIT ?`;
    params.push(opts.limit);
  }

  interface HistoryRow {
    id: number; timestamp: string; source: string; query: string;
    project: string | null; cwd: string | null; session_id: string | null;
    result_count: number; duration_ms: number;
    fts_duration_ms: number | null; vector_duration_ms: number | null;
  }
  const historyRows = db.prepare<HistoryRow, (string | number)[]>(`
    SELECT h.id, h.timestamp, h.source, h.query, h.project, h.cwd, h.session_id,
           h.result_count, h.duration_ms, h.fts_duration_ms, h.vector_duration_ms
    FROM search_history h
    ${where}
    ORDER BY h.timestamp DESC
    ${limitClause}
  `).all(...params);

  if (historyRows.length === 0) return [];

  // Batch load results for all history rows
  const historyIds = historyRows.map((h) => h.id);
  const placeholders = historyIds.map(() => "?").join(",");
  interface ResultRow {
    history_id: number; entry_id: string; title: string; score: number; tokens: number; algorithm: string;
  }
  const resultRows = db.prepare<ResultRow, number[]>(`
    SELECT history_id, entry_id, title, score, tokens, algorithm
    FROM search_results
    WHERE history_id IN (${placeholders})
  `).all(...historyIds);

  const resultsByHistory = new Map<number, SearchRecord["results"]>();
  for (const r of resultRows) {
    const list = resultsByHistory.get(r.history_id) ?? [];
    list.push({ id: r.entry_id, title: r.title, score: r.score, tokens: r.tokens, algorithm: r.algorithm });
    resultsByHistory.set(r.history_id, list);
  }

  return historyRows.map((h) => ({
    timestamp: h.timestamp,
    source: z.enum(["inject", "cli", "api"]).parse(h.source),
    query: h.query,
    project: h.project ?? undefined,
    cwd: h.cwd ?? undefined,
    sessionId: h.session_id ?? undefined,
    resultCount: h.result_count,
    results: resultsByHistory.get(h.id) ?? [],
    durationMs: h.duration_ms,
    ftsDurationMs: h.fts_duration_ms ?? undefined,
    vectorDurationMs: h.vector_duration_ms ?? undefined,
  }));
}

// ── Session entries ──────────────────────────────────────────────────────

export function getSessionEntries(
  sessionId: string,
): { id: string; title: string; score: number }[] {
  const db = getDb();

  const rows = db.prepare<{ id: string; title: string; score: number }, [string]>(`
    SELECT sr.entry_id as id, sr.title, MAX(sr.score) as score
    FROM search_results sr
    JOIN search_history sh ON sh.id = sr.history_id
    WHERE sh.session_id = ? AND sh.source = 'inject'
    GROUP BY sr.entry_id
  `).all(sessionId);

  return rows;
}

// ── Analytics ─────────────────────────────────────────────────────────

export interface SpeedTrendPoint {
  date: string;
  avgFtsDurationMs: number | null;
  avgVectorDurationMs: number | null;
  count: number;
}

export interface AlgorithmEvaluation {
  avgRating: number;
  totalEvaluated: number;
  distribution: Record<string, number>;
}

export interface SearchAnalytics {
  speedTrend: SpeedTrendPoint[];
  evaluationByAlgorithm: Record<string, AlgorithmEvaluation>;
}

export function getSearchAnalytics(): SearchAnalytics {
  const db = getDb();

  // Speed trend: avg durations per day, last 30 days
  interface SpeedRow {
    date: string;
    avg_fts: number | null;
    avg_vec: number | null;
    cnt: number;
  }
  const speedRows = db.prepare<SpeedRow, []>(`
    SELECT DATE(timestamp) as date,
           AVG(fts_duration_ms) as avg_fts,
           AVG(vector_duration_ms) as avg_vec,
           COUNT(*) as cnt
    FROM search_history
    WHERE timestamp >= DATE('now', '-30 days')
    GROUP BY DATE(timestamp)
    ORDER BY date ASC
  `).all();

  const speedTrend: SpeedTrendPoint[] = speedRows.map((r) => ({
    date: r.date,
    avgFtsDurationMs: r.avg_fts,
    avgVectorDurationMs: r.avg_vec,
    count: r.cnt,
  }));

  // Evaluation by algorithm: join search_results → search_history → signal_evaluations
  interface EvalRow {
    algorithm: string;
    rating: number;
  }
  const evalRows = db.prepare<EvalRow, []>(`
    SELECT sr.algorithm, se.rating
    FROM search_results sr
    JOIN search_history sh ON sh.id = sr.history_id
    JOIN signal_evaluations se
      ON se.session_id = sh.session_id
      AND se.entry_id = sr.entry_id
    WHERE sh.session_id IS NOT NULL
  `).all();

  // Post-process: split comma-separated algorithms and attribute to both groups
  const groups: Record<string, { total: number; sum: number; distribution: Record<string, number> }> = {};
  for (const row of evalRows) {
    const algos = row.algorithm.split(",");
    for (const algo of algos) {
      const key = algo.trim();
      if (key === "") continue;
      groups[key] ??= { total: 0, sum: 0, distribution: { "-1": 0, "0": 0, "1": 0, "2": 0 } };
      groups[key].total += 1;
      groups[key].sum += row.rating;
      groups[key].distribution[String(row.rating)] = (groups[key].distribution[String(row.rating)] ?? 0) + 1;
    }
  }

  const evaluationByAlgorithm: Record<string, AlgorithmEvaluation> = {};
  for (const [algo, data] of Object.entries(groups)) {
    evaluationByAlgorithm[algo] = {
      avgRating: data.total > 0 ? data.sum / data.total : 0,
      totalEvaluated: data.total,
      distribution: data.distribution,
    };
  }

  return { speedTrend, evaluationByAlgorithm };
}

// ── Stats ──────────────────────────────────────────────────────────────

export function getSearchStats(): SearchStats {
  const db = getDb();

  const total = db.prepare<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM search_history").get()!;
  if (total.cnt === 0) {
    return { totalQueries: 0, bySource: {}, zeroResultQueries: 0, avgResultCount: 0, topServedEntries: [], avgScoreOfServed: 0 };
  }

  const bySourceRows = db.prepare<{ source: string; cnt: number }, []>(
    "SELECT source, COUNT(*) as cnt FROM search_history GROUP BY source",
  ).all();
  const bySource: Record<string, number> = {};
  for (const r of bySourceRows) bySource[r.source] = r.cnt;

  const zeroResult = db.prepare<{ cnt: number }, []>(
    "SELECT COUNT(*) as cnt FROM search_history WHERE result_count = 0",
  ).get()!;

  const avgResult = db.prepare<{ avg: number }, []>(
    "SELECT AVG(result_count) as avg FROM search_history",
  ).get()!;

  const topEntries = db.prepare<{ id: string; title: string; count: number }, []>(`
    SELECT sr.entry_id as id, sr.title, COUNT(*) as count
    FROM search_results sr
    GROUP BY sr.entry_id
    ORDER BY count DESC
    LIMIT 10
  `).all();

  const avgScore = db.prepare<{ avg: number | null }, []>(
    "SELECT AVG(score) as avg FROM search_results",
  ).get()!;

  return {
    totalQueries: total.cnt,
    bySource,
    zeroResultQueries: zeroResult.cnt,
    avgResultCount: avgResult.avg,
    topServedEntries: topEntries,
    avgScoreOfServed: avgScore.avg ?? 0,
  };
}
