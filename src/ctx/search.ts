import { getDb } from "../db/connection.ts";
import type { IndexEntry, EntryRow } from "./store.ts";
import type { Scope } from "./store.ts";
import { ScopeSchema, TagsSchema } from "./store.ts";
import { getSignalScores, recordSearchHits } from "./signals.ts";
import { appendSearchRecord, type SearchSource } from "./search-history.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface SearchFilters {
  scope?: Scope;
  tags?: string[];
  project?: string;
}

export interface SearchResult extends IndexEntry {
  score: number;
  excerpt: string;
}

// ── Tokenizer ──────────────────────────────────────────────────────────

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ── FTS5 query builder ─────────────────────────────────────────────────

function buildFtsQuery(tokens: string[]): string {
  // Use prefix matching for each token, OR between them for broad recall
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

// ── Search ─────────────────────────────────────────────────────────────

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

export function search(
  query: string,
  filters: SearchFilters = {},
  limit = 10,
  meta?: SearchMeta,
): SearchResult[] {
  const start = Date.now();
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const ftsQuery = buildFtsQuery(tokens);
  const db = getDb();

  // Build WHERE clauses for filters
  const conditions: string[] = ["entries_fts MATCH ?"];
  const params: (string | number)[] = [ftsQuery];

  if (filters.scope) {
    conditions.push("e.scope = ?");
    params.push(filters.scope);
  }
  if (filters.project !== undefined) {
    conditions.push("e.project = ?");
    params.push(filters.project);
  }

  // BM25 weights: title=5, tags=3, body=1 (matching original TAG/TITLE/CONTENT weights)
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
  params.push(limit * 3); // Fetch extra to allow signal boosting to reorder

  const rows = db.prepare<FtsRow, (string | number)[]>(sql).all(...params);

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
  results.sort((a, b) => b.score - a.score);
  const maxScore = results.length > 0 ? results[0]!.score : 1;
  const finalResults = results.slice(0, limit);
  if (maxScore > 0) {
    for (const r of finalResults) {
      r.score = Math.round((r.score / maxScore) * 100) / 100;
    }
  }

  // Record which entries were served
  recordSearchHits(finalResults.map((r) => r.id));

  // Record search event to history (awaited to prevent process.exit race)
  if (meta?.source) {
    appendSearchRecord({
      timestamp: new Date().toISOString(),
      source: meta.source,
      query,
      project: meta.project,
      cwd: meta.cwd,
      sessionId: meta.sessionId,
      resultCount: finalResults.length,
      results: finalResults.map((r) => ({ id: r.id, title: r.title, score: r.score, tokens: r.tokens })),
      durationMs: Date.now() - start,
    });
  }

  return finalResults;
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
