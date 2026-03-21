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
