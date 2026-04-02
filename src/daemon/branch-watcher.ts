import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { getDb } from "../db/connection.ts";
import { runGit, errorMessage } from "../git/run.ts";
import { writeJob, jobTimestamp, isGitChangeProcessed } from "./jobs.ts";
import type { GitChangeJob } from "./jobs.ts";
import {
  fetchOrigin,
  getRemoteHeadSha,
  getWorktreePath,
  getBareClonePath,
  updateWorktree,
  addWorktree as cloneAddWorktree,
  removeWorktree as cloneRemoveWorktree,
  detectDefaultBranch,
  bareCloneExists,
  cloneBare,
  ensureRemoteTrackingRefs,
} from "../repo/clone.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface BranchWatch {
  id: number;
  repoId: number;
  branchName: string;
  lastSeenSha: string | null;
  lastCheckedAt: string | null;
  isDefault: boolean;
}

interface BranchWatchRow {
  id: number;
  repo_id: number;
  branch_name: string;
  last_seen_sha: string | null;
  last_checked_at: string | null;
  is_default: number;
}

interface TrackedRepoRow {
  id: number;
  abs_path: string;
  name: string;
  remote_url: string;
}

function rowToWatch(row: BranchWatchRow): BranchWatch {
  return {
    id: row.id,
    repoId: row.repo_id,
    branchName: row.branch_name,
    lastSeenSha: row.last_seen_sha,
    lastCheckedAt: row.last_checked_at,
    isDefault: row.is_default === 1,
  };
}

// ── Logging ──────────────────────────────────────────────────────────

function log(level: "info" | "error" | "warn", msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [branch-watcher] ${msg}`);
}

// ── Init ─────────────────────────────────────────────────────────────

/**
 * Create a branch watch for the default branch.
 * Seeds last_seen_sha from the bare clone's local refs (no network).
 */
export async function initBranchWatches(repoPath: string, repoId: number): Promise<void> {
  const defaultBranch = await detectDefaultBranch(repoId);
  if (defaultBranch === null) {
    log("warn", `could not detect default branch for ${repoPath} — skipping watch init`);
    return;
  }

  const sha = await getRemoteHeadSha(repoId, defaultBranch);

  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO branch_watches (repo_id, branch_name, last_seen_sha, last_checked_at, is_default)
    VALUES (?, ?, ?, ?, 1)
  `).run(repoId, defaultBranch, sha ?? null, new Date().toISOString());
}

// ── CRUD ─────────────────────────────────────────────────────────────

export async function addBranchWatch(repoId: number, branchName: string): Promise<void> {
  // Fetch latest refs and create worktree for the new branch
  await fetchOrigin(repoId);
  await cloneAddWorktree(repoId, branchName);

  const sha = await getRemoteHeadSha(repoId, branchName);

  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO branch_watches (repo_id, branch_name, last_seen_sha, last_checked_at, is_default)
    VALUES (?, ?, ?, ?, 0)
  `).run(repoId, branchName, sha ?? null, new Date().toISOString());
}

export async function removeBranchWatch(repoId: number, branchName: string): Promise<boolean> {
  const db = getDb();
  const result = db.prepare("DELETE FROM branch_watches WHERE repo_id = ? AND branch_name = ?")
    .run(repoId, branchName);
  if (result.changes === 0) return false;

  // Clean up worktree
  await cloneRemoveWorktree(repoId, branchName);
  return true;
}

export function listBranchWatches(repoId: number): BranchWatch[] {
  const db = getDb();
  const rows = db.prepare<BranchWatchRow, [number]>(
    "SELECT * FROM branch_watches WHERE repo_id = ? ORDER BY is_default DESC, branch_name",
  ).all(repoId);
  return rows.map(rowToWatch);
}

// ── Polling ──────────────────────────────────────────────────────────

const MAX_CONCURRENT_POLLS = 5;

/**
 * Poll all tracked repos for branch changes.
 * Uses bare clone fetch + local ref comparison (single network call per repo).
 * Returns total number of changes detected across all repos.
 */
export async function pollAllRepos(): Promise<number> {
  const db = getDb();
  const repos = db.prepare<TrackedRepoRow, []>(
    "SELECT id, abs_path, name, remote_url FROM tracked_repos ORDER BY id",
  ).all();

  let totalChanges = 0;

  for (let i = 0; i < repos.length; i += MAX_CONCURRENT_POLLS) {
    const batch = repos.slice(i, i + MAX_CONCURRENT_POLLS);
    const results = await Promise.allSettled(
      batch.map((repo) => pollRepo(repo.id, repo.abs_path, repo.name)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        totalChanges += result.value;
      }
    }
  }

  return totalChanges;
}

/**
 * Poll a single repo by path (for force-refresh / sync button).
 */
export async function pollSingleRepo(repoPath: string): Promise<number> {
  const normalized = resolve(repoPath);
  const db = getDb();
  const repo = db.prepare<TrackedRepoRow, [string]>(
    "SELECT id, abs_path, name, remote_url FROM tracked_repos WHERE abs_path = ?",
  ).get(normalized);
  if (!repo) return 0;

  return pollRepo(repo.id, repo.abs_path, repo.name);
}

async function pollRepo(repoId: number, repoPath: string, repoName: string): Promise<number> {
  // Single network call: fetch all remote refs into the bare clone
  await fetchOrigin(repoId);

  const db = getDb();
  const watches = db.prepare<BranchWatchRow, [number]>(
    "SELECT * FROM branch_watches WHERE repo_id = ?",
  ).all(repoId);

  if (watches.length === 0) return 0;

  let changesDetected = 0;
  const now = new Date().toISOString();
  const updates: Array<{ id: number; sha: string | null }> = [];

  for (const watch of watches) {
    // Local ref lookup (no network)
    const remoteSha = await getRemoteHeadSha(repoId, watch.branch_name);

    if (remoteSha === null) continue;

    if (watch.last_seen_sha === null) {
      updates.push({ id: watch.id, sha: remoteSha });
      continue;
    }

    if (remoteSha === watch.last_seen_sha) continue;

    // Change detected — update worktree and compute diffs
    const wtPath = getWorktreePath(repoId, watch.branch_name);
    await updateWorktree(repoId, watch.branch_name);

    if (isGitChangeProcessed(remoteSha, repoPath, watch.branch_name)) {
      updates.push({ id: watch.id, sha: remoteSha });
      continue;
    }

    // Compute diffs in the worktree
    const diffRange = `${watch.last_seen_sha}..${remoteSha}`;
    const [commitMessages, changedFiles, diffSummary] = await Promise.all([
      runGit(["log", "--oneline", diffRange], wtPath),
      runGit(["diff", "--name-status", diffRange], wtPath),
      runGit(["diff", "--stat", diffRange], wtPath),
    ]);

    const job: GitChangeJob = {
      type: "git-change",
      createdAt: now,
      repoPath,
      branch: watch.branch_name,
      previousSha: watch.last_seen_sha,
      currentSha: remoteSha,
      worktreePath: wtPath,
      commitMessages,
      changedFiles,
      diffSummary,
    };

    writeJob(job, `${jobTimestamp()}-git-change-${repoName}-${watch.branch_name}`);
    log("info", `change detected on ${repoName}/${watch.branch_name}: ${watch.last_seen_sha.slice(0, 8)}..${remoteSha.slice(0, 8)}`);

    updates.push({ id: watch.id, sha: remoteSha });
    changesDetected++;
  }

  if (updates.length > 0) {
    const stmt = db.prepare("UPDATE branch_watches SET last_seen_sha = ?, last_checked_at = ? WHERE id = ?");
    db.transaction(() => {
      for (const u of updates) {
        stmt.run(u.sha, now, u.id);
      }
    })();
  }

  return changesDetected;
}

// ── Startup migration ────────────────────────────────────────────────

/**
 * Ensure all tracked repos have a bare clone, worktrees, and branch watches.
 * Handles repos tracked before the worktree system was added.
 */
export async function ensureBranchWatches(): Promise<void> {
  const db = getDb();
  const allRepos = db.prepare<TrackedRepoRow, []>(
    "SELECT id, abs_path, name, remote_url FROM tracked_repos ORDER BY id",
  ).all();

  for (const repo of allRepos) {
    if (repo.remote_url === "") continue;

    try {
      // Ensure bare clone exists with proper remote tracking refs
      if (!(await bareCloneExists(repo.id))) {
        log("info", `creating bare clone for ${repo.name}...`);
        await cloneBare(repo.remote_url, repo.id);
      } else {
        // Fix existing bare clones that may have wrong fetch refspec
        await ensureRemoteTrackingRefs(repo.id);
      }

      // Ensure branch watches exist
      const watches = db.prepare<BranchWatchRow, [number]>(
        "SELECT * FROM branch_watches WHERE repo_id = ?",
      ).all(repo.id);

      if (watches.length === 0) {
        const defaultBranch = await detectDefaultBranch(repo.id);
        if (defaultBranch !== null) {
          await cloneAddWorktree(repo.id, defaultBranch);
        }
        await initBranchWatches(repo.abs_path, repo.id);
        log("info", `initialized branch watch for ${repo.name}`);
      } else {
        // Ensure worktrees exist for all watched branches
        for (const watch of watches) {
          const wtPath = getWorktreePath(repo.id, watch.branch_name);
          try {
            await stat(wtPath);
          } catch {
            log("info", `creating missing worktree for ${repo.name}/${watch.branch_name}...`);
            await cloneAddWorktree(repo.id, watch.branch_name);
          }
        }
      }
    } catch (err) {
      log("warn", `failed to ensure clone/watches for ${repo.name}: ${errorMessage(err)}`);
    }
  }
}

// ── Remote branch listing (for UI) ──────────────────────────────────

export async function listRemoteBranches(repoPath: string): Promise<string[]> {
  // Query from the user's repo (not the bare clone) for branch listing
  // since we need the absPath to resolve repo ID
  const normalized = resolve(repoPath);
  const db = getDb();
  const repo = db.prepare<{ id: number }, [string]>(
    "SELECT id FROM tracked_repos WHERE abs_path = ?",
  ).get(normalized);

  if (!repo) return [];

  // Fetch latest refs first
  await fetchOrigin(repo.id);

  // List branches from bare clone's remote refs
  const output = await runGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"],
    getBareClonePath(repo.id),
  );

  if (output === "") return [];

  return output.split("\n")
    .map((ref) => ref.replace(/^origin\//, ""))
    .filter((name) => name !== "" && name !== "HEAD")
    .sort();
}
