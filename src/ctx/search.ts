import { join } from "node:path";
import { loadIndex, hiveRoot, type IndexEntry } from "./store.ts";
import type { Scope } from "./store.ts";

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

// ── Scoring ────────────────────────────────────────────────────────────

const TAG_WEIGHT = 5;
const TITLE_WEIGHT = 3;
const CONTENT_WEIGHT = 1;
const CONTENT_CAP_PER_TOKEN = 5;

export function scoreEntry(
  tokens: string[],
  entry: IndexEntry,
  content: string
): number {
  let score = 0;
  const titleLower = entry.title.toLowerCase();
  const tagsLower = entry.tags.map((t) => t.toLowerCase());
  const contentLower = content.toLowerCase();

  for (const token of tokens) {
    // Tag match (exact)
    if (tagsLower.includes(token)) {
      score += TAG_WEIGHT;
    }

    // Title match (substring)
    if (titleLower.includes(token)) {
      score += TITLE_WEIGHT;
    }

    // Content match (count occurrences, capped)
    let count = 0;
    let idx = 0;
    while ((idx = contentLower.indexOf(token, idx)) !== -1) {
      count++;
      idx += token.length;
      if (count >= CONTENT_CAP_PER_TOKEN) break;
    }
    score += count * CONTENT_WEIGHT;
  }

  return score;
}

function extractExcerpt(body: string, tokens: string[], maxLen = 150): string {
  const bodyLower = body.toLowerCase();
  // Find the first token occurrence and extract around it
  for (const token of tokens) {
    const idx = bodyLower.indexOf(token);
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, idx + maxLen - 40);
      let excerpt = body.slice(start, end).replace(/\n/g, " ").trim();
      if (start > 0) excerpt = "..." + excerpt;
      if (end < body.length) excerpt = excerpt + "...";
      return excerpt;
    }
  }
  // Fallback: first N chars
  const excerpt = body.slice(0, maxLen).replace(/\n/g, " ").trim();
  return excerpt.length < body.length ? excerpt + "..." : excerpt;
}

// ── Search ─────────────────────────────────────────────────────────────

export async function search(
  query: string,
  filters: SearchFilters = {},
  limit = 10
): Promise<SearchResult[]> {
  const index = await loadIndex();
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  // Pre-filter
  let candidates = index;
  if (filters.scope) {
    candidates = candidates.filter((e) => e.scope === filters.scope);
  }
  if (filters.tags && filters.tags.length > 0) {
    const filterTags = filters.tags.map((t) => t.toLowerCase());
    candidates = candidates.filter((e) =>
      filterTags.some((ft) => e.tags.map((t) => t.toLowerCase()).includes(ft))
    );
  }
  if (filters.project !== undefined) {
    candidates = candidates.filter((e) => e.project === filters.project);
  }

  // Score
  const results: SearchResult[] = [];
  const root = hiveRoot();

  for (const entry of candidates) {
    const filePath = join(root, entry.path);
    let content = "";
    try {
      content = await Bun.file(filePath).text();
    } catch {
      continue;
    }

    const score = scoreEntry(tokens, entry, content);
    if (score > 0) {
      // Extract body (after frontmatter) for excerpt
      const bodyMatch = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(content);
      const body = bodyMatch !== null ? (bodyMatch[1] ?? "").trim() : content;

      results.push({
        ...entry,
        score,
        excerpt: extractExcerpt(body, tokens),
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ── Formatters ─────────────────────────────────────────────────────────

export function formatHuman(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";

  return results
    .map((r, i) => {
      const tags = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
      return [
        `${i + 1}. ${r.title}${tags}`,
        `   id: ${r.id}  scope: ${r.scope}  score: ${r.score}`,
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
      return `### ${r.title}\n**id:** ${r.id} | **scope:** ${r.scope} | **score:** ${r.score}${tags}\n\n${r.excerpt}`;
    })
    .join("\n\n---\n\n");
}
