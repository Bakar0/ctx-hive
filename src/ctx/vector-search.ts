import { getDb, isSqliteVecAvailable } from "../db/connection.ts";
import type { SearchResult, SearchFilters } from "./search.ts";
import { ScopeSchema, TagsSchema } from "./store.ts";
import type { EntryRow } from "./store.ts";
import { getSignalScores } from "./signals.ts";
import { generateEmbedding } from "./embeddings.ts";
import { getVectorSearchConfig } from "./settings.ts";

// ── Embedding sync ────────────────────────────────────────────────────

/**
 * Insert or replace an entry's embedding in vec_entries.
 */
export function syncEntryEmbedding(entryId: string, embedding: Float32Array): void {
  if (!isSqliteVecAvailable()) return;
  const db = getDb();
  // vec0 uses DELETE + INSERT for upsert since it doesn't support ON CONFLICT
  db.prepare("DELETE FROM vec_entries WHERE entry_id = ?").run(entryId);
  db.prepare("INSERT INTO vec_entries (entry_id, embedding) VALUES (?, ?)").run(
    entryId,
    embedding,
  );
}

/**
 * Count how many entries have embeddings in vec_entries.
 */
export function countEmbeddings(): number {
  if (!isSqliteVecAvailable()) return 0;
  const db = getDb();
  const row = db.prepare<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM vec_entries").get();
  return row?.cnt ?? 0;
}

/**
 * Get IDs of entries that are missing from vec_entries.
 */
export function getEntriesMissingEmbeddings(): { id: string; title: string; body: string }[] {
  if (!isSqliteVecAvailable()) return [];
  const db = getDb();
  return db.prepare<{ id: string; title: string; body: string }, []>(`
    SELECT e.id, e.title, e.body
    FROM entries e
    LEFT JOIN vec_entries v ON v.entry_id = e.id
    WHERE v.entry_id IS NULL AND e.deleted_at IS NULL
  `).all();
}

// ── Vector search ─────────────────────────────────────────────────────

interface VecRow {
  entry_id: string;
  distance: number;
}

/**
 * Run vector similarity search using sqlite-vec KNN.
 * Returns SearchResult[] compatible with FTS5 search results.
 */
export async function vectorSearch(
  query: string,
  filters: SearchFilters = {},
  limit = 10,
): Promise<SearchResult[]> {
  if (!isSqliteVecAvailable()) return [];
  const config = getVectorSearchConfig();
  if (!config.enabled || config.apiKey === null) return [];

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query, config.apiKey, config.model);

  const db = getDb();

  // KNN search — fetch more than limit to allow for post-filtering
  const knnLimit = limit * 5;
  const vecRows = db.prepare<VecRow, [Float32Array, number]>(`
    SELECT entry_id, distance
    FROM vec_entries
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(queryEmbedding, knnLimit);

  if (vecRows.length === 0) return [];

  // Load full entry data for matched IDs
  const ids = vecRows.map((r) => r.entry_id);
  const placeholders = ids.map(() => "?").join(",");
  const entryRows = db.prepare<EntryRow, string[]>(`
    SELECT id, title, slug, scope, tags, project,
           SUBSTR(body, 1, 150) as body, tokens,
           created_at, updated_at
    FROM entries
    WHERE id IN (${placeholders}) AND deleted_at IS NULL
  `).all(...ids);

  const entryMap = new Map(entryRows.map((r) => [r.id, r]));

  // Build results with distance-based scoring
  let results: SearchResult[] = [];
  for (const vec of vecRows) {
    const entry = entryMap.get(vec.entry_id);
    if (entry === undefined) continue;

    const scope = ScopeSchema.safeParse(entry.scope);
    if (!scope.success) continue;

    // Apply filters
    if (filters.scope !== undefined && scope.data !== filters.scope) continue;
    if (filters.project !== undefined && entry.project !== filters.project) continue;
    if (filters.tags !== undefined && filters.tags.length > 0) {
      const entryTags = TagsSchema.parse(JSON.parse(entry.tags)).map((t) => t.toLowerCase());
      const filterTags = filters.tags.map((t) => t.toLowerCase());
      if (!filterTags.some((ft) => entryTags.includes(ft))) continue;
    }

    // Convert distance to similarity score (cosine distance → similarity)
    // sqlite-vec returns L2 distance by default for float vectors
    // Lower distance = more similar. Convert to 0-1 score.
    const similarity = 1 / (1 + vec.distance);

    results.push({
      id: entry.id,
      title: entry.title,
      scope: scope.data,
      tags: TagsSchema.parse(JSON.parse(entry.tags)),
      project: entry.project,
      created: entry.created_at,
      updated: entry.updated_at,
      tokens: entry.tokens,
      path: `entries/${entry.scope}/${entry.slug}.md`,
      score: similarity,
      excerpt: entry.body.slice(0, 150),
    });

    if (results.length >= limit) break;
  }

  // Apply signal boost
  const entryIds = results.map((r) => r.id);
  const signalScores = getSignalScores(entryIds);
  for (const r of results) {
    const boost = signalScores[r.id] ?? 0;
    r.score = r.score * (1 + boost);
  }

  // Normalize scores to 0-1
  results.sort((a, b) => b.score - a.score);
  const maxScore = results.length > 0 ? Math.max(results[0]!.score, 0.1) : 1;
  for (const r of results) {
    r.score = Math.round(Math.min(1, r.score / maxScore) * 100) / 100;
  }

  return results;
}
