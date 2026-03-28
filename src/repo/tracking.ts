import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { getDb } from "../db/connection.ts";
import { resolveRepoMeta } from "../ctx/init.ts";
import { patchRepoHooks } from "../hooks/git-installer.ts";

// ── Schemas & Types ───────────────────────────────────────────────────

const TrackedRepoSchema = z.object({
  name: z.string(),
  absPath: z.string(),
  org: z.string(),
  remoteUrl: z.string(),
  trackedAt: z.string(),
  lastScannedAt: z.string().optional(),
});

export type TrackedRepo = z.infer<typeof TrackedRepoSchema>;

// ── Row type ──────────────────────────────────────────────────────────

interface RepoRow {
  id: number;
  name: string;
  abs_path: string;
  org: string;
  remote_url: string;
  tracked_at: string;
  last_scanned_at: string | null;
}

function rowToTrackedRepo(row: RepoRow): TrackedRepo {
  return {
    name: row.name,
    absPath: row.abs_path,
    org: row.org,
    remoteUrl: row.remote_url,
    trackedAt: row.tracked_at,
    lastScannedAt: row.last_scanned_at ?? undefined,
  };
}

// ── Load / Save ────────────────────────────────────────────────────────

export function loadTrackedRepos(): TrackedRepo[] {
  const db = getDb();
  const rows = db.prepare<RepoRow, []>("SELECT * FROM tracked_repos ORDER BY tracked_at").all();
  return rows.map(rowToTrackedRepo);
}

// ── Track / Untrack ────────────────────────────────────────────────────

export async function trackRepo(absPath: string): Promise<TrackedRepo> {
  const normalized = resolve(absPath);

  try {
    const gitStat = await stat(join(normalized, ".git"));
    if (!gitStat.isDirectory()) {
      throw new Error(`Not a git repository: ${normalized}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Not a git")) throw err;
    throw new Error(`Not a git repository or path not found: ${normalized}`);
  }

  const db = getDb();

  // Dedup by absPath
  const existing = db.prepare<RepoRow, [string]>("SELECT * FROM tracked_repos WHERE abs_path = ?").get(normalized);
  if (existing) return rowToTrackedRepo(existing);

  const meta = await resolveRepoMeta(normalized);
  const tracked: TrackedRepo = {
    name: meta.name,
    absPath: normalized,
    org: meta.org,
    remoteUrl: meta.remoteUrl,
    trackedAt: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO tracked_repos (name, abs_path, org, remote_url, tracked_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tracked.name, tracked.absPath, tracked.org, tracked.remoteUrl, tracked.trackedAt);

  await patchRepoHooks(normalized);

  return tracked;
}

export function untrackRepo(absPath: string): boolean {
  const normalized = resolve(absPath);
  const db = getDb();
  const result = db.prepare("DELETE FROM tracked_repos WHERE abs_path = ?").run(normalized);
  return result.changes > 0;
}

/**
 * Find the tracked repo that contains the given path.
 * Matches exactly or by ancestor (path is inside a tracked repo).
 * Returns the most specific (deepest) match.
 */
export function findTrackedRepoFor(
  path: string,
  repos: TrackedRepo[],
): TrackedRepo | undefined {
  const normalized = resolve(path);
  const exact = repos.find((r) => r.absPath === normalized);
  if (exact) return exact;
  let best: TrackedRepo | undefined;
  for (const r of repos) {
    if (normalized.startsWith(r.absPath + "/")) {
      if (!best || r.absPath.length > best.absPath.length) best = r;
    }
  }
  return best;
}

export function updateLastScanned(absPath: string): void {
  const normalized = resolve(absPath);
  const db = getDb();
  db.prepare("UPDATE tracked_repos SET last_scanned_at = ? WHERE abs_path = ?")
    .run(new Date().toISOString(), normalized);
}

