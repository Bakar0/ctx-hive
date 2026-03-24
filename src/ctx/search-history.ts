/**
 * Append-only JSONL log of search and injection events.
 * Enables review of search efficiency over time.
 */
import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import { hiveRoot } from "./store.ts";

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
  results: { id: string; title: string; score: number; tokens: number }[];
  durationMs: number;
}

export interface SearchStats {
  totalQueries: number;
  bySource: Record<string, number>;
  zeroResultQueries: number;
  avgResultCount: number;
  topServedEntries: { id: string; title: string; count: number }[];
  avgScoreOfServed: number;
}

// ── Path ───────────────────────────────────────────────────────────────

const HISTORY_PATH = join(hiveRoot(), "search-history.jsonl");

export function historyPath(): string {
  return HISTORY_PATH;
}

// ── Append ─────────────────────────────────────────────────────────────

export async function appendSearchRecord(record: SearchRecord): Promise<void> {
  const line = JSON.stringify(record) + "\n";
  await appendFile(HISTORY_PATH, line);
}

// ── Load ───────────────────────────────────────────────────────────────

export async function loadSearchHistory(opts?: {
  since?: Date;
  limit?: number;
}): Promise<SearchRecord[]> {
  const file = Bun.file(HISTORY_PATH);
  if (!(await file.exists())) return [];

  const text = await file.text();
  const lines = text.split("\n").filter((l) => l.length > 0);

  let records: SearchRecord[] = [];
  for (const line of lines) {
    try {
      // oxlint-disable-next-line no-unsafe-type-assertion -- JSONL lines are serialized SearchRecords
      records.push(JSON.parse(line) as SearchRecord);
    } catch {
      // skip malformed lines
    }
  }

  if (opts?.since) {
    const sinceMs = opts.since.getTime();
    records = records.filter((r) => new Date(r.timestamp).getTime() >= sinceMs);
  }

  // Return newest first
  records.reverse();

  if (opts?.limit !== undefined && opts.limit > 0) {
    records = records.slice(0, opts.limit);
  }

  return records;
}

// ── Session entries ──────────────────────────────────────────────────────

/**
 * Get deduplicated entries that were injected in a specific session.
 * Returns the highest-scoring version of each entry.
 */
export async function getSessionEntries(
  sessionId: string,
): Promise<{ id: string; title: string; score: number }[]> {
  const records = await loadSearchHistory();
  const seen = new Map<string, { id: string; title: string; score: number }>();
  for (const r of records) {
    if (r.sessionId !== sessionId || r.source !== "inject") continue;
    for (const result of r.results) {
      const existing = seen.get(result.id);
      if (existing === undefined || result.score > existing.score) {
        seen.set(result.id, result);
      }
    }
  }
  return [...seen.values()];
}

// ── Stats ──────────────────────────────────────────────────────────────

export async function getSearchStats(): Promise<SearchStats> {
  const records = await loadSearchHistory();

  if (records.length === 0) {
    return {
      totalQueries: 0,
      bySource: {},
      zeroResultQueries: 0,
      avgResultCount: 0,
      topServedEntries: [],
      avgScoreOfServed: 0,
    };
  }

  const bySource: Record<string, number> = {};
  let zeroResultQueries = 0;
  let totalResults = 0;
  let totalScore = 0;
  let scoredCount = 0;
  const entryCounts = new Map<string, { title: string; count: number }>();

  for (const record of records) {
    bySource[record.source] = (bySource[record.source] ?? 0) + 1;

    if (record.resultCount === 0) {
      zeroResultQueries++;
    }

    totalResults += record.resultCount;

    for (const result of record.results) {
      totalScore += result.score;
      scoredCount++;

      const existing = entryCounts.get(result.id);
      if (existing) {
        existing.count++;
      } else {
        entryCounts.set(result.id, { title: result.title, count: 1 });
      }
    }
  }

  const topServedEntries = [...entryCounts.entries()]
    .map(([id, { title, count }]) => ({ id, title, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalQueries: records.length,
    bySource,
    zeroResultQueries,
    avgResultCount: totalResults / records.length,
    topServedEntries,
    avgScoreOfServed: scoredCount > 0 ? totalScore / scoredCount : 0,
  };
}
