import { getDb } from "../db/connection.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface HitBucket {
  date: string;   // "2026-03-22"
  count: number;
}

export interface RelevanceEval {
  evaluatedAt: string;
  sessionId: string;
  rating: -1 | 0 | 1 | 2;
  reason?: string;
}

export interface EntrySignals {
  searchHits: HitBucket[];
  evaluations: RelevanceEval[];
  score: number;
  scoreComputedAt: string;
}

export interface SignalsStore {
  entries: Record<string, EntrySignals>;
  updatedAt: string;
  version: 1;
}

// ── Constants ──────────────────────────────────────────────────────────

const USAGE_HALF_LIFE_DAYS = 30;
const RELEVANCE_HALF_LIFE_DAYS = 60;
const USAGE_DECAY_LAMBDA = Math.LN2 / USAGE_HALF_LIFE_DAYS;
const RELEVANCE_DECAY_LAMBDA = Math.LN2 / RELEVANCE_HALF_LIFE_DAYS;

const HIT_PRUNE_DAYS = 180;
const EVAL_PRUNE_DAYS = 365;

const USAGE_WEIGHT = 0.3;
const RELEVANCE_WEIGHT = 0.7;

const RATING_MAP: Record<number, number> = {
  [-1]: 0,
  [0]: 0.25,
  [1]: 0.75,
  [2]: 1.0,
};

// ── Helpers ────────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}

// ── Score Computation ──────────────────────────────────────────────────

export function computeUsageScore(hits: HitBucket[], now: Date): number {
  let weightedHits = 0;
  for (const bucket of hits) {
    const daysAgo = daysBetween(new Date(bucket.date), now);
    weightedHits += bucket.count * Math.exp(-USAGE_DECAY_LAMBDA * daysAgo);
  }
  return 1 - Math.exp(-weightedHits / 10);
}

export function computeRelevanceScore(evals: RelevanceEval[], now: Date): number {
  if (evals.length === 0) return 0.5;

  let weightedSum = 0;
  let weightTotal = 0;

  for (const ev of evals) {
    const daysAgo = daysBetween(new Date(ev.evaluatedAt), now);
    const weight = Math.exp(-RELEVANCE_DECAY_LAMBDA * daysAgo);
    const normalized = RATING_MAP[ev.rating] ?? 0.5;
    weightedSum += normalized * weight;
    weightTotal += weight;
  }

  return weightTotal > 0 ? weightedSum / weightTotal : 0.5;
}

export function computeScore(signals: EntrySignals, now: Date): number {
  const usage = computeUsageScore(signals.searchHits, now);
  const relevance = computeRelevanceScore(signals.evaluations, now);
  return USAGE_WEIGHT * usage + RELEVANCE_WEIGHT * relevance;
}

// ── Recording ──────────────────────────────────────────────────────────

export function recordSearchHits(entryIds: string[]): void {
  if (entryIds.length === 0) return;
  const db = getDb();
  const today = todayString();

  const upsert = db.prepare(`
    INSERT INTO signal_hits (entry_id, date, count) VALUES (?, ?, 1)
    ON CONFLICT(entry_id, date) DO UPDATE SET count = count + 1
  `);

  const tx = db.transaction(() => {
    for (const id of entryIds) {
      upsert.run(id, today);
    }
  });
  tx();
}

export function recordEvaluation(
  entryId: string,
  evaluation: RelevanceEval,
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO signal_evaluations (entry_id, session_id, rating, reason, evaluated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(entryId, evaluation.sessionId, evaluation.rating, evaluation.reason ?? null, evaluation.evaluatedAt);
}

// ── Query ──────────────────────────────────────────────────────────────

export function getSignalScores(entryIds: string[]): Record<string, number> {
  if (entryIds.length === 0) return {};
  const db = getDb();
  const now = new Date();
  const scores: Record<string, number> = {};

  // Batch load all hits and evals for the given entry IDs
  const placeholders = entryIds.map(() => "?").join(",");

  const hits = db.prepare<{ entry_id: string; date: string; count: number }, string[]>(
    `SELECT entry_id, date, count FROM signal_hits WHERE entry_id IN (${placeholders})`,
  ).all(...entryIds);

  const evals = db.prepare<RelevanceEval & { entry_id: string }, string[]>(
    `SELECT entry_id, evaluated_at as evaluatedAt, session_id as sessionId, rating, reason FROM signal_evaluations WHERE entry_id IN (${placeholders})`,
  ).all(...entryIds);

  // Group by entry ID
  const hitsByEntry = new Map<string, HitBucket[]>();
  for (const h of hits) {
    const list = hitsByEntry.get(h.entry_id) ?? [];
    list.push({ date: h.date, count: h.count });
    hitsByEntry.set(h.entry_id, list);
  }

  const evalsByEntry = new Map<string, RelevanceEval[]>();
  for (const e of evals) {
    const list = evalsByEntry.get(e.entry_id) ?? [];
    list.push({ evaluatedAt: e.evaluatedAt, sessionId: e.sessionId, rating: e.rating, reason: e.reason });
    evalsByEntry.set(e.entry_id, list);
  }

  for (const id of entryIds) {
    const signals: EntrySignals = {
      searchHits: hitsByEntry.get(id) ?? [],
      evaluations: evalsByEntry.get(id) ?? [],
      score: 0,
      scoreComputedAt: now.toISOString(),
    };
    signals.score = computeScore(signals, now);
    scores[id] = signals.score;
  }

  return scores;
}

// ── Load full signals store (for API compatibility) ───────────────────

export function loadSignals(): SignalsStore {
  const db = getDb();

  const allHits = db.prepare<{ entry_id: string; date: string; count: number }, []>(
    "SELECT entry_id, date, count FROM signal_hits",
  ).all();

  const allEvals = db.prepare<RelevanceEval & { entry_id: string }, []>(
    "SELECT entry_id, evaluated_at as evaluatedAt, session_id as sessionId, rating, reason FROM signal_evaluations",
  ).all();

  const entries: Record<string, EntrySignals> = {};
  const now = new Date();

  for (const h of allHits) {
    entries[h.entry_id] ??= { searchHits: [], evaluations: [], score: 0, scoreComputedAt: now.toISOString() };
    entries[h.entry_id]!.searchHits.push({ date: h.date, count: h.count });
  }

  for (const e of allEvals) {
    entries[e.entry_id] ??= { searchHits: [], evaluations: [], score: 0, scoreComputedAt: now.toISOString() };
    entries[e.entry_id]!.evaluations.push({
      evaluatedAt: e.evaluatedAt, sessionId: e.sessionId, rating: e.rating, reason: e.reason,
    });
  }

  for (const signals of Object.values(entries)) {
    signals.score = computeScore(signals, now);
    signals.scoreComputedAt = now.toISOString();
  }

  return { entries, updatedAt: now.toISOString(), version: 1 };
}

// ── Recompute & Prune ──────────────────────────────────────────────────

export function recomputeAllScores(): void {
  const db = getDb();
  const now = new Date();

  const hitCutoff = new Date(now.getTime() - HIT_PRUNE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const evalCutoff = new Date(now.getTime() - EVAL_PRUNE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Prune old data
  db.prepare("DELETE FROM signal_hits WHERE date < ?").run(hitCutoff);
  db.prepare("DELETE FROM signal_evaluations WHERE evaluated_at < ?").run(evalCutoff);

  // Prune orphan entries (signals for entries that no longer exist)
  db.exec("DELETE FROM signal_hits WHERE entry_id NOT IN (SELECT id FROM entries)");
  db.exec("DELETE FROM signal_evaluations WHERE entry_id NOT IN (SELECT id FROM entries)");
}
