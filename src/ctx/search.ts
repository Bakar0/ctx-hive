import { getDb } from "../db/connection.ts";
import type { IndexEntry, EntryRow } from "./store.ts";
import type { Scope } from "./store.ts";
import { ScopeSchema, TagsSchema } from "./store.ts";
import { getSignalScores, recordSearchHits } from "./signals.ts";
import { appendSearchRecord, type SearchSource } from "./search-history.ts";
import { isVectorSearchEnabled } from "./settings.ts";
import { vectorSearch } from "./vector-search.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface SearchFilters {
  scope?: Scope;
  tags?: string[];
  project?: string;
}

export interface SearchResult extends IndexEntry {
  score: number;
  excerpt: string;
  algorithms?: ("fts5" | "vector")[];
}

export type Algorithm = "fts5" | "vector";

export interface AlgorithmResult {
  algorithm: Algorithm;
  results: SearchResult[];
  durationMs: number;
}

export interface MultiSearchResult {
  merged: SearchResult[];
  algorithms: AlgorithmResult[];
  mergeStrategy: "fts5-only" | "rrf";
}

// ── Tokenizer ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could",
  "i", "me", "my", "we", "our", "you", "your", "it", "its",
  "this", "that", "these", "those", "there", "here",
  "of", "in", "to", "for", "with", "on", "at", "from", "by", "about",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "and", "but", "or", "nor", "not", "so", "if", "then", "than",
  "also", "just", "only", "very", "too", "some", "any", "all", "each",
  // Imperative verbs common in prompts but low-signal for search
  "fix", "add", "implement", "refactor", "update", "change", "make",
  "create", "write", "move", "remove", "delete", "get", "set",
  "use", "try", "check", "look", "find", "see", "show", "tell",
  "need", "want", "like", "please", "help",
]);

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Remove stopwords and low-signal verbs from tokens for FTS5 queries.
 * Always keeps at least one token (the longest) to avoid empty queries.
 */
export function filterTokens(tokens: string[]): string[] {
  const filtered = tokens.filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (filtered.length === 0 && tokens.length > 0) {
    // Keep the longest token as a fallback
    return [tokens.reduce((a, b) => (a.length >= b.length ? a : b))];
  }
  return filtered;
}

// ── FTS5 query builder ─────────────────────────────────────────────────

/**
 * Build an FTS5 query from tokens.
 * - Single token: prefix match ("token"*)
 * - Multiple tokens: AND between terms for precision, prefix on last token for typeahead
 * - Falls back to OR if AND produces no results (caller handles this)
 */
export function buildFtsQuery(tokens: string[]): string {
  if (tokens.length === 0) return "";
  if (tokens.length === 1) return `"${tokens[0]}"*`;

  // AND between all terms; prefix match only on the last token (typeahead)
  const parts = tokens.map((t, i) =>
    i === tokens.length - 1 ? `"${t}"*` : `"${t}"`,
  );
  return parts.join(" AND ");
}

/**
 * Build a fallback OR query for when AND is too restrictive.
 */
export function buildFtsQueryOr(tokens: string[]): string {
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

// ── FTS5 Search ───────────────────────────────────────────────────────

export interface SearchMeta {
  source?: SearchSource;
  project?: string;
  cwd?: string;
  sessionId?: string;
}

interface FtsRow extends EntryRow {
  fts_score: number;
  excerpt: string;
}

/**
 * Run FTS5 full-text search only. Returns scored, normalized results.
 */
export function ftsSearch(
  query: string,
  filters: SearchFilters = {},
  limit = 10,
): SearchResult[] {
  const rawTokens = tokenize(query);
  if (rawTokens.length === 0) return [];

  const searchTokens = filterTokens(rawTokens);
  const ftsQuery = buildFtsQuery(searchTokens);
  if (ftsQuery === "") return [];
  const db = getDb();

  // Helper to run FTS5 query with filters
  function runFtsQuery(matchQuery: string): FtsRow[] {
    const conditions: string[] = ["entries_fts MATCH ?"];
    const params: (string | number)[] = [matchQuery];

    if (filters.scope) {
      conditions.push("e.scope = ?");
      params.push(filters.scope);
    }
    if (filters.project !== undefined) {
      conditions.push("e.project = ?");
      params.push(filters.project);
    }

    const sql = `
      SELECT e.id, e.title, e.slug, e.scope, e.tags, e.project,
             SUBSTR(e.body, 1, 150) as body, e.tokens,
             e.created_at, e.updated_at,
             bm25(entries_fts, 5.0, 3.0, 1.0) as fts_score,
             snippet(entries_fts, 2, '', '', '...', 32) as excerpt
      FROM entries_fts
      JOIN entries e ON entries_fts.rowid = e.rowid
      WHERE ${conditions.join(" AND ")}
      ORDER BY fts_score
      LIMIT ?
    `;
    params.push(limit * 3);
    return db.prepare<FtsRow, (string | number)[]>(sql).all(...params);
  }

  // Try AND query first (precise), fall back to OR (broad recall) if no results
  let rows = runFtsQuery(ftsQuery);
  if (rows.length === 0 && searchTokens.length > 1) {
    rows = runFtsQuery(buildFtsQueryOr(searchTokens));
  }

  // Apply tag filter (FTS5 can't filter by exact tag membership)
  let filtered = rows;
  if (filters.tags && filters.tags.length > 0) {
    const filterTags = filters.tags.map((t) => t.toLowerCase());
    filtered = rows.filter((row) => {
      const rowTags = TagsSchema.parse(JSON.parse(row.tags)).map((t) => t.toLowerCase());
      return filterTags.some((ft) => rowTags.includes(ft));
    });
  }

  // Build results with signal boost
  const entryIds = filtered.map((r) => r.id);
  const signalScores = getSignalScores(entryIds);

  const results: SearchResult[] = filtered.map((row) => {
    const textScore = Math.abs(row.fts_score); // BM25 returns negative values
    const boost = signalScores[row.id] ?? 0;
    const score = textScore * (1 + boost);

    return {
      id: row.id,
      title: row.title,
      scope: ScopeSchema.parse(row.scope),
      tags: TagsSchema.parse(JSON.parse(row.tags)),
      project: row.project,
      created: row.created_at,
      updated: row.updated_at,
      tokens: row.tokens,
      path: `entries/${row.scope}/${row.slug}.md`,
      score,
      excerpt: row.excerpt || row.body.slice(0, 150),
    };
  });

  // Sort by score descending and normalize to 0-1
  const NORM_FLOOR = 2.0;
  results.sort((a, b) => b.score - a.score);
  const finalResults = results.slice(0, limit);
  const maxScore = finalResults.length > 0 ? Math.max(finalResults[0]!.score, NORM_FLOOR) : 1;
  for (const r of finalResults) {
    r.score = Math.round(Math.min(1, r.score / maxScore) * 100) / 100;
  }

  return finalResults;
}

// ── Reciprocal Rank Fusion ────────────────────────────────────────────

/**
 * Merge results from multiple algorithms using Reciprocal Rank Fusion.
 * RRF is rank-based so it avoids scale mismatch between BM25 and cosine similarity.
 */
export function reciprocalRankFusion(
  resultSets: { algorithm: Algorithm; results: SearchResult[] }[],
  k = 60,
): SearchResult[] {
  const rrfScores = new Map<string, { score: number; algorithms: Algorithm[]; result: SearchResult }>();

  for (const { algorithm, results } of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank]!;
      const rrfScore = 1 / (k + rank + 1);
      const existing = rrfScores.get(r.id);

      if (existing !== undefined) {
        existing.score += rrfScore;
        if (!existing.algorithms.includes(algorithm)) {
          existing.algorithms.push(algorithm);
        }
        // Keep the result with the better excerpt
        if (r.excerpt.length > existing.result.excerpt.length) {
          existing.result = { ...r };
        }
      } else {
        rrfScores.set(r.id, {
          score: rrfScore,
          algorithms: [algorithm],
          result: { ...r },
        });
      }
    }
  }

  // Sort by RRF score descending
  const merged = [...rrfScores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ score, algorithms, result }) => ({
      ...result,
      score: Math.round(score * 10000) / 10000,
      algorithms,
    }));

  // Normalize scores to 0-1
  if (merged.length > 0) {
    const maxScore = merged[0]!.score;
    for (const r of merged) {
      r.score = maxScore > 0 ? Math.round((r.score / maxScore) * 100) / 100 : 0;
    }
  }

  return merged;
}

// ── Multi-algorithm search ────────────────────────────────────────────

/**
 * Run all enabled search algorithms in parallel and merge results.
 */
export async function searchMulti(
  query: string,
  filters: SearchFilters = {},
  limit = 10,
  meta?: SearchMeta,
): Promise<MultiSearchResult> {
  const overallStart = Date.now();
  const algorithms: AlgorithmResult[] = [];
  const vectorEnabled = isVectorSearchEnabled();

  // Run FTS5 (always) and vector search (if enabled) in parallel
  const ftsStart = Date.now();
  const ftsPromise = Promise.resolve(ftsSearch(query, filters, limit));

  const vecPromise = vectorEnabled
    ? (async () => {
        const vecStart = Date.now();
        const results = await vectorSearch(query, filters, limit);
        return { results, durationMs: Date.now() - vecStart };
      })()
    : null;

  const [ftsResults, vecResult] = await Promise.all([
    ftsPromise.then((results) => ({
      results,
      durationMs: Date.now() - ftsStart,
    })),
    vecPromise,
  ]);

  algorithms.push({
    algorithm: "fts5" as const,
    results: ftsResults.results,
    durationMs: ftsResults.durationMs,
  });

  if (vecResult !== null) {
    algorithms.push({
      algorithm: "vector" as const,
      results: vecResult.results,
      durationMs: vecResult.durationMs,
    });
  }

  // Merge results
  let merged: SearchResult[];
  let mergeStrategy: "fts5-only" | "rrf";

  if (vecResult !== null && vecResult.results.length > 0) {
    merged = reciprocalRankFusion(
      algorithms.map((a) => ({ algorithm: a.algorithm, results: a.results })),
    ).slice(0, limit);
    mergeStrategy = "rrf";
  } else {
    merged = ftsResults.results.map((r) => ({ ...r, algorithms: ["fts5" as const] }));
    mergeStrategy = "fts5-only";
  }

  // Record search hits for merged results
  recordSearchHits(merged.map((r) => r.id));

  // Record search event to history
  if (meta?.source) {
    appendSearchRecord({
      timestamp: new Date().toISOString(),
      source: meta.source,
      query,
      project: meta.project,
      cwd: meta.cwd,
      sessionId: meta.sessionId,
      resultCount: merged.length,
      results: merged.map((r) => ({
        id: r.id,
        title: r.title,
        score: r.score,
        tokens: r.tokens,
        algorithm: r.algorithms?.join(",") ?? "fts5",
      })),
      durationMs: Date.now() - overallStart,
      ftsDurationMs: ftsResults.durationMs,
      vectorDurationMs: vecResult?.durationMs,
    });
  }

  return { merged, algorithms, mergeStrategy };
}

// ── Formatters ─────────────────────────────────────────────────────────

export function formatHuman(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";

  return results
    .map((r, i) => {
      const tags = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
      return [
        `${i + 1}. ${r.title}${tags}`,
        `   id: ${r.id}  scope: ${r.scope}  relevance: ${r.score}  tokens: ${r.tokens}`,
        `   ${r.excerpt}`,
      ].join("\n");
    })
    .join("\n\n");
}

export function formatJson(results: SearchResult[], query: string): string {
  return JSON.stringify({ query, results }, null, 2);
}

export function formatMarkdown(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";

  return results
    .map((r) => {
      const tags = r.tags.length > 0 ? `  \nTags: ${r.tags.join(", ")}` : "";
      return `### ${r.title}\n**id:** ${r.id} | **scope:** ${r.scope} | **relevance:** ${r.score} | **tokens:** ${r.tokens}${tags}\n\n${r.excerpt}`;
    })
    .join("\n\n---\n\n");
}
