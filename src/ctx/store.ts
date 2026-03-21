import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

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
}

export interface IndexEntry extends EntryMeta {
  path: string; // relative to hive root, e.g. "entries/org/some-slug.md"
}

export interface Entry extends EntryMeta {
  body: string;
}

// ── Paths ──────────────────────────────────────────────────────────────

const HIVE_ROOT = join(homedir(), ".omni", "context-hive");
const ENTRIES_DIR = join(HIVE_ROOT, "entries");
const INDEX_PATH = join(HIVE_ROOT, "index.json");

export const SCOPES: Scope[] = ["project", "org", "personal"];

export function isScope(value: string): value is Scope {
  return (SCOPES as string[]).includes(value);
}

export function hiveRoot() {
  return HIVE_ROOT;
}

export function entriesDir() {
  return ENTRIES_DIR;
}

export function indexPath() {
  return INDEX_PATH;
}

// ── Init ───────────────────────────────────────────────────────────────

export async function ensureCtxDir(): Promise<void> {
  for (const scope of SCOPES) {
    await mkdir(join(ENTRIES_DIR, scope), { recursive: true });
  }
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

// ── Frontmatter parsing ────────────────────────────────────────────────

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

    // Strip surrounding quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    // Parse arrays: ["a", "b", "c"]
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

  return {
    meta: {
      id: str("id"),
      title: str("title"),
      scope: isScope(scopeVal) ? scopeVal : "personal",
      tags: Array.isArray(meta.tags) ? (meta.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
      project: str("project"),
      created: str("created"),
      updated: str("updated"),
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
---

${body}
`;
}

// ── Entry CRUD ─────────────────────────────────────────────────────────

function entryPath(scope: Scope, slug: string): string {
  return join(ENTRIES_DIR, scope, `${slug}.md`);
}

function relativeEntryPath(scope: Scope, slug: string): string {
  return `entries/${scope}/${slug}.md`;
}

export async function writeEntry(meta: EntryMeta, body: string): Promise<string> {
  await ensureCtxDir();
  const slug = slugify(meta.title);
  const filePath = entryPath(meta.scope, slug);
  await Bun.write(filePath, serializeEntry(meta, body));
  await rebuildIndex();
  return slug;
}

export async function readEntry(scope: Scope, slug: string): Promise<Entry> {
  const filePath = entryPath(scope, slug);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Entry not found: ${scope}/${slug}`);
  }
  const raw = await file.text();
  const { meta, body } = parseFrontmatter(raw);
  return { ...meta, body };
}

export async function deleteEntry(scope: Scope, slug: string): Promise<void> {
  const filePath = entryPath(scope, slug);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Entry not found: ${scope}/${slug}`);
  }
  await rm(filePath);
  await rebuildIndex();
}

// ── Index ──────────────────────────────────────────────────────────────

export async function rebuildIndex(): Promise<IndexEntry[]> {
  await ensureCtxDir();
  const entries: IndexEntry[] = [];

  for (const scope of SCOPES) {
    const scopeDir = join(ENTRIES_DIR, scope);
    let files: string[];
    try {
      files = await readdir(scopeDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const slug = file.replace(/\.md$/, "");
      try {
        const raw = await Bun.file(join(scopeDir, file)).text();
        const { meta } = parseFrontmatter(raw);
        entries.push({
          ...meta,
          path: relativeEntryPath(scope, slug),
        });
      } catch {
        // Skip malformed entries
      }
    }
  }

  await Bun.write(INDEX_PATH, JSON.stringify(entries, null, 2));
  return entries;
}

export async function loadIndex(): Promise<IndexEntry[]> {
  const file = Bun.file(INDEX_PATH);
  if (!(await file.exists())) {
    return rebuildIndex();
  }
  const data: unknown = await file.json();
  // oxlint-disable-next-line no-unsafe-type-assertion -- index.json is self-managed
  return data as IndexEntry[];
}

// ── Lookup by ID or slug ───────────────────────────────────────────────

export async function resolveEntry(
  idOrSlug: string
): Promise<{ scope: Scope; slug: string } | null> {
  const index = await loadIndex();

  // Try ID match first
  const byId = index.find((e) => e.id === idOrSlug);
  if (byId) {
    const slug = byId.path.replace(/^entries\/[^/]+\//, "").replace(/\.md$/, "");
    return { scope: byId.scope, slug };
  }

  // Try slug match across scopes
  for (const entry of index) {
    const slug = entry.path.replace(/^entries\/[^/]+\//, "").replace(/\.md$/, "");
    if (slug === idOrSlug) {
      return { scope: entry.scope, slug };
    }
  }

  return null;
}
