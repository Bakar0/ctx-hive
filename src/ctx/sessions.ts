import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { encodePath, projectSessionDir } from "../adapter/claude-paths.ts";

// ── Path encoding ──────────────────────────────────────────────────────

/** @deprecated Use encodePath from shared/claude-paths.ts directly */
export function encodeSessionPath(repoPath: string): string {
  return encodePath(repoPath);
}

/**
 * Return the Claude session directory for a repo path.
 */
export function repoToSessionDir(repoPath: string): string {
  return projectSessionDir(repoPath);
}

// ── Session discovery ──────────────────────────────────────────────────

export interface SessionFile {
  path: string;
  mtime: Date;
}

/**
 * List .jsonl session files sorted by mtime (newest first).
 */
export async function listSessionFiles(sessionDir: string): Promise<SessionFile[]> {
  let files: string[];
  try {
    files = await readdir(sessionDir);
  } catch {
    return [];
  }

  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  const withStats: SessionFile[] = [];

  for (const f of jsonlFiles) {
    const fullPath = join(sessionDir, f);
    try {
      const s = await stat(fullPath);
      withStats.push({ path: fullPath, mtime: s.mtime });
    } catch {
      // skip inaccessible files
    }
  }

  withStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return withStats;
}

// ── Session file paths for Claude ──────────────────────────────────────

/**
 * Get the top N session file paths for a repo, sorted by most recent.
 */
export async function getSessionFilePaths(
  repoPath: string,
  maxSessions: number = 10,
): Promise<string[]> {
  const sessionDir = repoToSessionDir(repoPath);
  const files = await listSessionFiles(sessionDir);
  return files.slice(0, maxSessions).map((f) => f.path);
}

// ── Extract served entry IDs from a transcript ──────────────────────

export type ServedSource = "inject" | "search" | "unknown";

export interface ServedEntryInfo {
  id: string;
  source: ServedSource;
}

// Matches **id:** <8-hex> optionally followed by **source:** inject on the same line
const ENTRY_ID_WITH_SOURCE_PATTERN = /\*\*id:\*\*\s*([0-9a-f]{8})[^\n]*?\*\*source:\*\*\s*(inject|search)/g;
// Fallback: just the id without source marker
const ENTRY_ID_PATTERN = /\*\*id:\*\*\s*([0-9a-f]{8})/g;

/**
 * Scan a session JSONL transcript for entry IDs that appeared in
 * ctx-hive search results or injections. Returns enriched info
 * with source detection (inject vs search vs unknown).
 */
export async function extractServedEntriesWithSource(transcriptPath: string): Promise<ServedEntryInfo[]> {
  const file = Bun.file(transcriptPath);
  if (!(await file.exists())) return [];

  const content = await file.text();
  const result = new Map<string, ServedSource>();

  // First pass: find entries with explicit source markers
  let match: RegExpExecArray | null;
  while ((match = ENTRY_ID_WITH_SOURCE_PATTERN.exec(content)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) {
      const source: ServedSource = match[2] === "inject" ? "inject" : "search";
      result.set(match[1], source);
    }
  }

  // Second pass: find any remaining IDs without source markers
  ENTRY_ID_PATTERN.lastIndex = 0;
  while ((match = ENTRY_ID_PATTERN.exec(content)) !== null) {
    if (match[1] !== undefined && !result.has(match[1])) {
      result.set(match[1], "unknown");
    }
  }

  return [...result.entries()].map(([id, source]) => ({ id, source }));
}

/**
 * Backward-compatible: returns just the IDs.
 */
export async function extractServedEntries(transcriptPath: string): Promise<string[]> {
  const entries = await extractServedEntriesWithSource(transcriptPath);
  return entries.map((e) => e.id);
}
