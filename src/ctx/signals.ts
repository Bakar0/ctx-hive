import { join } from "node:path";
import { z } from "zod";
import { hiveRoot, loadIndex } from "./store.ts";

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

// ── Schemas ────────────────────────────────────────────────────────────

const HitBucketSchema = z.object({
  date: z.string(),
  count: z.number(),
});

const RelevanceEvalSchema = z.object({
  evaluatedAt: z.string(),
  sessionId: z.string(),
  rating: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]),
  reason: z.string().optional(),
});

const EntrySignalsSchema = z.object({
  searchHits: z.array(HitBucketSchema),
  evaluations: z.array(RelevanceEvalSchema),
  score: z.number(),
  scoreComputedAt: z.string(),
});

const SignalsStoreSchema = z.object({
  entries: z.record(z.string(), EntrySignalsSchema),
  updatedAt: z.string(),
  version: z.literal(1),
});

// ── Constants ──────────────────────────────────────────────────────────

const SIGNALS_PATH = join(hiveRoot(), "signals.json");

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

function emptyStore(): SignalsStore {
  return { entries: {}, updatedAt: new Date().toISOString(), version: 1 };
}

function emptyEntrySignals(): EntrySignals {
  return {
    searchHits: [],
    evaluations: [],
    score: 0,
    scoreComputedAt: new Date().toISOString(),
  };
}

// ── Load / Save ────────────────────────────────────────────────────────

export async function loadSignals(): Promise<SignalsStore> {
  const file = Bun.file(SIGNALS_PATH);
  if (!(await file.exists())) return emptyStore();
  try {
    return SignalsStoreSchema.parse(await file.json());
  } catch {
    return emptyStore();
  }
}

export async function saveSignals(store: SignalsStore): Promise<void> {
  store.updatedAt = new Date().toISOString();
  await Bun.write(SIGNALS_PATH, JSON.stringify(store, null, 2));
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

export async function recordSearchHits(entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;
  const store = await loadSignals();
  const today = todayString();

  for (const id of entryIds) {
    store.entries[id] ??= emptyEntrySignals();
    const signals = store.entries[id];

    const bucket = signals.searchHits.find((b) => b.date === today);
    if (bucket !== undefined) {
      bucket.count++;
    } else {
      signals.searchHits.push({ date: today, count: 1 });
    }

    signals.score = computeScore(signals, new Date());
    signals.scoreComputedAt = new Date().toISOString();
  }

  await saveSignals(store);
}

export async function recordEvaluation(
  entryId: string,
  evaluation: RelevanceEval,
): Promise<void> {
  const store = await loadSignals();

  store.entries[entryId] ??= emptyEntrySignals();
  const signals = store.entries[entryId];
  signals.evaluations.push(evaluation);

  signals.score = computeScore(signals, new Date());
  signals.scoreComputedAt = new Date().toISOString();

  await saveSignals(store);
}

// ── Query ──────────────────────────────────────────────────────────────

export async function getSignalScore(entryId: string): Promise<number> {
  const store = await loadSignals();
  return store.entries[entryId]?.score ?? 0;
}

export async function getSignalScores(entryIds: string[]): Promise<Record<string, number>> {
  const store = await loadSignals();
  const scores: Record<string, number> = {};
  for (const id of entryIds) {
    scores[id] = store.entries[id]?.score ?? 0;
  }
  return scores;
}

// ── Recompute & Prune ──────────────────────────────────────────────────

export async function recomputeAllScores(): Promise<void> {
  const store = await loadSignals();
  const now = new Date();
  const index = await loadIndex();
  const validIds = new Set(index.map((e) => e.id));

  const hitCutoff = new Date(now.getTime() - HIT_PRUNE_DAYS * 24 * 60 * 60 * 1000);
  const evalCutoff = new Date(now.getTime() - EVAL_PRUNE_DAYS * 24 * 60 * 60 * 1000);

  // Prune orphan entries
  for (const id of Object.keys(store.entries)) {
    if (!validIds.has(id)) {
      delete store.entries[id];
    }
  }

  // Prune old data and recompute
  for (const signals of Object.values(store.entries)) {
    signals.searchHits = signals.searchHits.filter(
      (b) => new Date(b.date) >= hitCutoff,
    );
    signals.evaluations = signals.evaluations.filter(
      (e) => new Date(e.evaluatedAt) >= evalCutoff,
    );
    signals.score = computeScore(signals, now);
    signals.scoreComputedAt = now.toISOString();
  }

  await saveSignals(store);
}
