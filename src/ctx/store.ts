import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { countTokens } from "@anthropic-ai/tokenizer";
import { getDb } from "../db/connection.ts";
import { isVectorSearchEnabled, getVectorSearchConfig } from "./settings.ts";
import { generateEmbedding } from "./embeddings.ts";
import { syncEntryEmbedding } from "./vector-search.ts";

// ── Types ──────────────────────────────────────────────────────────────

export type Scope = "project" | "org" | "personal";

export interface EntryMeta {
  id: string;
  title: string;
  scope: Scope;
  tags: string[];
  project: string;
  created: string;
  updated: string;
  tokens: number;
}

export interface IndexEntry extends EntryMeta {
  path: string; // kept for backward compat — derived as "entries/{scope}/{slug}.md"
}

export interface Entry extends EntryMeta {
  body: string;
}

// ── Paths ──────────────────────────────────────────────────────────────

const HIVE_ROOT = join(homedir(), ".ctx-hive");

export const SCOPES: Scope[] = ["project", "org", "personal"];

export const ScopeSchema = z.enum(["project", "org", "personal"]);
export const TagsSchema = z.array(z.string());

export function isScope(value: string): value is Scope {
  return (SCOPES as string[]).includes(value);
}

export function hiveRoot() {
  return HIVE_ROOT;
}

// ── ID & Slug ──────────────────────────────────────────────────────────

export function generateId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ── Row → domain type helpers ──────────────────────────────────────────

export interface EntryRow {
  id: string;
  title: string;
  slug: string;
  scope: string;
  tags: string;
  project: string;
  body: string;
  tokens: number;
  created_at: string;
  updated_at: string;
}

function rowToMeta(row: EntryRow): EntryMeta {
  return {
    id: row.id,
    title: row.title,
    scope: ScopeSchema.parse(row.scope),
    tags: TagsSchema.parse(JSON.parse(row.tags)),
    project: row.project,
    created: row.created_at,
    updated: row.updated_at,
    tokens: row.tokens,
  };
}

function rowToIndexEntry(row: EntryRow): IndexEntry {
  return {
    ...rowToMeta(row),
    path: `entries/${row.scope}/${row.slug}.md`,
  };
}

function rowToEntry(row: EntryRow): Entry {
  return {
    ...rowToMeta(row),
    body: row.body,
  };
}

// ── Entry CRUD ─────────────────────────────────────────────────────────

export function writeEntry(meta: EntryMeta, body: string): string {
  const db = getDb();
  const slug = slugify(meta.title);
  const serialized = `${meta.title}\n${body}`;
  const tokens = countTokens(serialized);
  const tags = JSON.stringify(meta.tags);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO entries (id, title, slug, scope, tags, project, body, tokens, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, slug = excluded.slug, scope = excluded.scope,
      tags = excluded.tags, project = excluded.project, body = excluded.body,
      tokens = excluded.tokens, updated_at = excluded.updated_at
  `).run(meta.id, meta.title, slug, meta.scope, tags, meta.project, body, tokens, meta.created || now, now);

  // Fire-and-forget: generate and store embedding when vector search is enabled
  if (isVectorSearchEnabled()) {
    const config = getVectorSearchConfig();
    if (config.apiKey !== null) {
      const text = `${meta.title}\n${body}`;
      generateEmbedding(text, config.apiKey, config.model)
        .then((embedding) => syncEntryEmbedding(meta.id, embedding))
        .catch((err) => console.error(`[embeddings] Failed for ${meta.id}:`, err));
    }
  }

  return slug;
}

export function readEntry(scope: Scope, slug: string): Entry {
  const db = getDb();
  const row = db.prepare<EntryRow, [string, string]>("SELECT * FROM entries WHERE scope = ? AND slug = ?").get(scope, slug);
  if (!row) throw new Error(`Entry not found: ${scope}/${slug}`);
  return rowToEntry(row);
}

export function deleteEntry(scope: Scope, slug: string): void {
  const db = getDb();
  const result = db.prepare("DELETE FROM entries WHERE scope = ? AND slug = ?").run(scope, slug);
  if (result.changes === 0) throw new Error(`Entry not found: ${scope}/${slug}`);
}

// ── Index ──────────────────────────────────────────────────────────────

export function loadIndex(): IndexEntry[] {
  const db = getDb();
  const rows = db.prepare<EntryRow, []>(
    "SELECT id, title, slug, scope, tags, project, '' as body, tokens, created_at, updated_at FROM entries ORDER BY updated_at DESC",
  ).all();
  return rows.map(rowToIndexEntry);
}

/**
 * Loads full entries with bodies. Used by dashboard memories endpoint.
 */
export function loadIndexEntries(): (IndexEntry & { body: string })[] {
  const db = getDb();
  const rows = db.prepare<EntryRow, []>(
    "SELECT id, title, slug, scope, tags, project, body, tokens, created_at, updated_at FROM entries ORDER BY updated_at DESC",
  ).all();
  return rows.map((row) => ({ ...rowToIndexEntry(row), body: row.body }));
}

/** No-op — kept for backward compat. FTS5 triggers handle index sync. */
export function rebuildIndex(): IndexEntry[] {
  return loadIndex();
}

// ── Lookup by ID or slug ───────────────────────────────────────────────

export function resolveEntry(
  idOrSlug: string,
): { scope: Scope; slug: string } | null {
  const db = getDb();

  const byId = db.prepare<{ scope: string; slug: string }, [string]>("SELECT scope, slug FROM entries WHERE id = ?").get(idOrSlug);
  if (byId) {
    return { scope: ScopeSchema.parse(byId.scope), slug: byId.slug };
  }

  const bySlug = db.prepare<{ scope: string; slug: string }, [string]>("SELECT scope, slug FROM entries WHERE slug = ? LIMIT 1").get(idOrSlug);
  if (bySlug) {
    return { scope: ScopeSchema.parse(bySlug.scope), slug: bySlug.slug };
  }

  return null;
}

// ── Frontmatter parsing (kept for seed/migration) ──────────────────────

export function parseFrontmatter(raw: string): { meta: EntryMeta; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (match === null) throw new Error("Invalid entry: missing frontmatter");

  const [, yamlBlock = "", bodyRaw = ""] = match;
  const body = bodyRaw.trim();

  const meta: Record<string, unknown> = {};
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: string | string[] = line.slice(colonIdx + 1).trim();

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
    }

    meta[key] = value;
  }

  const str = (key: string): string =>
    typeof meta[key] === "string" ? meta[key] : "";
  const scopeVal = str("scope");

  const tokensVal = str("tokens");
  return {
    meta: {
      id: str("id"),
      title: str("title"),
      scope: isScope(scopeVal) ? scopeVal : "personal",
      tags: Array.isArray(meta.tags) ? (meta.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
      project: str("project"),
      created: str("created"),
      updated: str("updated"),
      tokens: tokensVal !== "" ? parseInt(tokensVal, 10) : 0,
    },
    body,
  };
}

export function serializeEntry(meta: EntryMeta, body: string): string {
  const tags = meta.tags.length > 0 ? `[${meta.tags.map((t) => `"${t}"`).join(", ")}]` : "[]";
  return `---
id: "${meta.id}"
title: "${meta.title}"
scope: "${meta.scope}"
tags: ${tags}
project: "${meta.project}"
created: "${meta.created}"
updated: "${meta.updated}"
tokens: ${meta.tokens}
---

${body}
`;
}

export async function ensureCtxDir(): Promise<void> {
  // No-op — DB handles storage now
}
