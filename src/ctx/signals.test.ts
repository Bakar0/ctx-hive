import { test, expect, describe } from "bun:test";
import {
  computeUsageScore,
  computeRelevanceScore,
  computeScore,
  daysBetween,
  type HitBucket,
  type RelevanceEval,
  type EntrySignals,
} from "./signals.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function makeSignals(
  hits: HitBucket[] = [],
  evals: RelevanceEval[] = [],
): EntrySignals {
  return {
    searchHits: hits,
    evaluations: evals,
    score: 0,
    scoreComputedAt: new Date().toISOString(),
  };
}

// ── daysBetween ────────────────────────────────────────────────────────

describe("daysBetween", () => {
  test("same date returns 0", () => {
    const d = new Date("2026-03-22");
    expect(daysBetween(d, d)).toBe(0);
  });

  test("one day apart", () => {
    const a = new Date("2026-03-22");
    const b = new Date("2026-03-23");
    expect(daysBetween(a, b)).toBeCloseTo(1, 1);
  });

  test("order does not matter", () => {
    const a = new Date("2026-03-01");
    const b = new Date("2026-03-15");
    expect(daysBetween(a, b)).toBeCloseTo(daysBetween(b, a), 5);
  });
});

// ── computeUsageScore ──────────────────────────────────────────────────

describe("computeUsageScore", () => {
  const now = new Date();

  test("no hits returns 0", () => {
    expect(computeUsageScore([], now)).toBe(0);
  });

  test("recent hits produce positive score", () => {
    const hits: HitBucket[] = [{ date: daysAgo(0), count: 5 }];
    const score = computeUsageScore(hits, now);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("more hits produce higher score", () => {
    const few: HitBucket[] = [{ date: daysAgo(0), count: 2 }];
    const many: HitBucket[] = [{ date: daysAgo(0), count: 20 }];
    expect(computeUsageScore(many, now)).toBeGreaterThan(
      computeUsageScore(few, now),
    );
  });

  test("old hits contribute less than recent hits", () => {
    const recent: HitBucket[] = [{ date: daysAgo(1), count: 5 }];
    const old: HitBucket[] = [{ date: daysAgo(60), count: 5 }];
    expect(computeUsageScore(recent, now)).toBeGreaterThan(
      computeUsageScore(old, now),
    );
  });

  test("score saturates toward 1", () => {
    const hits: HitBucket[] = [{ date: daysAgo(0), count: 100 }];
    const score = computeUsageScore(hits, now);
    expect(score).toBeGreaterThan(0.99);
  });

  test("same-day bucket increments accumulate", () => {
    const single: HitBucket[] = [{ date: daysAgo(0), count: 10 }];
    const split: HitBucket[] = [
      { date: daysAgo(0), count: 5 },
      { date: daysAgo(0), count: 5 },
    ];
    // Both should produce the same score since same total count on same day
    expect(computeUsageScore(single, now)).toBeCloseTo(
      computeUsageScore(split, now),
      5,
    );
  });
});

// ── computeRelevanceScore ──────────────────────────────────────────────

describe("computeRelevanceScore", () => {
  const now = new Date();

  test("no evaluations returns 0.5 (neutral)", () => {
    expect(computeRelevanceScore([], now)).toBe(0.5);
  });

  test("single positive evaluation", () => {
    const evals: RelevanceEval[] = [
      { evaluatedAt: daysAgoISO(0), sessionId: "s1", rating: 2 },
    ];
    const score = computeRelevanceScore(evals, now);
    expect(score).toBeCloseTo(1.0, 1);
  });

  test("single negative evaluation", () => {
    const evals: RelevanceEval[] = [
      { evaluatedAt: daysAgoISO(0), sessionId: "s1", rating: -1 },
    ];
    const score = computeRelevanceScore(evals, now);
    expect(score).toBeCloseTo(0, 1);
  });

  test("mixed evaluations average out", () => {
    const evals: RelevanceEval[] = [
      { evaluatedAt: daysAgoISO(0), sessionId: "s1", rating: 2 },
      { evaluatedAt: daysAgoISO(0), sessionId: "s2", rating: -1 },
    ];
    const score = computeRelevanceScore(evals, now);
    expect(score).toBeCloseTo(0.5, 1);
  });

  test("recent evaluations outweigh old ones", () => {
    const recentGood: RelevanceEval[] = [
      { evaluatedAt: daysAgoISO(1), sessionId: "s1", rating: 2 },
      { evaluatedAt: daysAgoISO(120), sessionId: "s2", rating: -1 },
    ];
    const score = computeRelevanceScore(recentGood, now);
    expect(score).toBeGreaterThan(0.5);
  });

  test("rating 0 maps to 0.25", () => {
    const evals: RelevanceEval[] = [
      { evaluatedAt: daysAgoISO(0), sessionId: "s1", rating: 0 },
    ];
    const score = computeRelevanceScore(evals, now);
    expect(score).toBeCloseTo(0.25, 1);
  });

  test("rating 1 maps to 0.75", () => {
    const evals: RelevanceEval[] = [
      { evaluatedAt: daysAgoISO(0), sessionId: "s1", rating: 1 },
    ];
    const score = computeRelevanceScore(evals, now);
    expect(score).toBeCloseTo(0.75, 1);
  });
});

// ── computeScore (composite) ──────────────────────────────────────────

describe("computeScore", () => {
  const now = new Date();

  test("empty signals produce neutral relevance + zero usage", () => {
    const signals = makeSignals();
    const score = computeScore(signals, now);
    // 0.3 * 0 + 0.7 * 0.5 = 0.35
    expect(score).toBeCloseTo(0.35, 2);
  });

  test("high usage + high relevance produces high score", () => {
    const signals = makeSignals(
      [{ date: daysAgo(0), count: 50 }],
      [{ evaluatedAt: daysAgoISO(0), sessionId: "s1", rating: 2 }],
    );
    const score = computeScore(signals, now);
    expect(score).toBeGreaterThan(0.9);
  });

  test("high usage + negative relevance produces low score", () => {
    const signals = makeSignals(
      [{ date: daysAgo(0), count: 50 }],
      [{ evaluatedAt: daysAgoISO(0), sessionId: "s1", rating: -1 }],
    );
    const score = computeScore(signals, now);
    // relevance dominates at 0.7 weight and rating -1 → 0
    expect(score).toBeLessThan(0.35);
  });

  test("relevance weight is higher than usage weight", () => {
    // Same entry with high relevance but low usage should score higher
    // than one with high usage but low relevance
    const highRelevance = makeSignals(
      [{ date: daysAgo(0), count: 1 }],
      [{ evaluatedAt: daysAgoISO(0), sessionId: "s1", rating: 2 }],
    );
    const highUsage = makeSignals(
      [{ date: daysAgo(0), count: 50 }],
      [{ evaluatedAt: daysAgoISO(0), sessionId: "s1", rating: 0 }],
    );
    expect(computeScore(highRelevance, now)).toBeGreaterThan(
      computeScore(highUsage, now),
    );
  });
});
