import type { HitBucket, RelevanceEval } from "../api/types";

// ── Constants (mirror src/ctx/signals.ts) ─────────────────────────────

const USAGE_HALF_LIFE_DAYS = 30;
const RELEVANCE_HALF_LIFE_DAYS = 60;
const USAGE_DECAY_LAMBDA = Math.LN2 / USAGE_HALF_LIFE_DAYS;
const RELEVANCE_DECAY_LAMBDA = Math.LN2 / RELEVANCE_HALF_LIFE_DAYS;

const RATING_MAP: Record<number, number> = {
  [-1]: 0,
  [0]: 0.25,
  [1]: 0.75,
  [2]: 1.0,
};

export const RATING_LEGEND = [
  { rating: -1, label: "Harmful", normalized: 0, color: "var(--destructive)" },
  { rating: 0, label: "Irrelevant", normalized: 0.25, color: "var(--dim)" },
  { rating: 1, label: "Referenced", normalized: 0.75, color: "var(--warning)" },
  { rating: 2, label: "Relied upon", normalized: 1.0, color: "var(--success)" },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}

// ── Score computation ─────────────────────────────────────────────────

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
