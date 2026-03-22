import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { scanForRepos, resolveRepoMeta } from "../ctx/init.ts";
import { loadIndex } from "../ctx/store.ts";
import { loadTrackedRepos, type TrackedRepo } from "./tracking.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface DiscoveredRepo {
  name: string;
  absPath: string;
  relPath: string;
  org: string;
  remoteUrl: string;
  tracked: boolean;
  trackedAt?: string;
  lastScannedAt?: string;
  contextCount: number;
  currentBranch: string;
  behindCount: number;
  defaultBranch: string;
  exists: boolean;
}

// ── Git helpers ────────────────────────────────────────────────────────

async function gitCommand(
  repoPath: string,
  args: string[],
): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim();
  } catch {
    return "";
  }
}

export async function getRepoBranchInfo(
  repoPath: string,
): Promise<{ currentBranch: string; behindCount: number; defaultBranch: string }> {
  const currentBranch = await gitCommand(repoPath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);

  // Try to detect default branch from origin
  let defaultBranch = "main";
  const remoteHead = await gitCommand(repoPath, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "--short",
  ]);
  if (remoteHead) {
    // e.g. "origin/main" -> "main"
    defaultBranch = remoteHead.replace(/^origin\//, "");
  }

  // Count commits behind remote default branch
  let behindCount = 0;
  const behindStr = await gitCommand(repoPath, [
    "rev-list",
    "--count",
    `HEAD..origin/${defaultBranch}`,
  ]);
  if (behindStr) {
    const n = parseInt(behindStr, 10);
    if (!Number.isNaN(n)) behindCount = n;
  }

  return { currentBranch, behindCount, defaultBranch };
}

// ── Path helpers ───────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

// ── Discover repos ─────────────────────────────────────────────────────

export async function discoverRepos(
  rootPath: string,
  maxDepth: number = 4,
): Promise<DiscoveredRepo[]> {
  const root = expandHome(rootPath);

  const [scanned, tracked, index] = await Promise.all([
    scanForRepos(root, maxDepth),
    loadTrackedRepos(),
    loadIndex(),
  ]);

  // Build context count map: project name -> count
  const contextCounts = new Map<string, number>();
  for (const entry of index) {
    if (entry.project) {
      contextCounts.set(entry.project, (contextCounts.get(entry.project) ?? 0) + 1);
    }
  }

  // Build tracked map: absPath -> TrackedRepo
  const trackedMap = new Map<string, TrackedRepo>();
  for (const t of tracked) {
    trackedMap.set(t.absPath, t);
  }

  // Enrich in parallel
  const results = await Promise.all(
    scanned.map(async (repo): Promise<DiscoveredRepo> => {
      const [meta, branchInfo] = await Promise.all([
        resolveRepoMeta(repo.absPath),
        getRepoBranchInfo(repo.absPath),
      ]);

      const t = trackedMap.get(repo.absPath);

      return {
        name: meta.name,
        absPath: repo.absPath,
        relPath: repo.relPath,
        org: meta.org,
        remoteUrl: meta.remoteUrl,
        tracked: t !== undefined,
        trackedAt: t?.trackedAt,
        lastScannedAt: t?.lastScannedAt,
        contextCount: contextCounts.get(meta.name) ?? 0,
        currentBranch: branchInfo.currentBranch,
        behindCount: branchInfo.behindCount,
        defaultBranch: branchInfo.defaultBranch,
        exists: true,
      };
    }),
  );

  return results;
}

// ── Enrich tracked repos ───────────────────────────────────────────────

export async function enrichTrackedRepos(): Promise<DiscoveredRepo[]> {
  const [tracked, index] = await Promise.all([
    loadTrackedRepos(),
    loadIndex(),
  ]);

  const contextCounts = new Map<string, number>();
  for (const entry of index) {
    if (entry.project) {
      contextCounts.set(entry.project, (contextCounts.get(entry.project) ?? 0) + 1);
    }
  }

  const results = await Promise.all(
    tracked.map(async (repo): Promise<DiscoveredRepo> => {
      let exists = true;
      try {
        await stat(repo.absPath);
      } catch {
        exists = false;
      }

      let branchInfo = { currentBranch: "", behindCount: 0, defaultBranch: "main" };
      if (exists) {
        branchInfo = await getRepoBranchInfo(repo.absPath);
      }

      return {
        name: repo.name,
        absPath: repo.absPath,
        relPath: repo.absPath.replace(homedir(), "~"),
        org: repo.org,
        remoteUrl: repo.remoteUrl,
        tracked: true,
        trackedAt: repo.trackedAt,
        lastScannedAt: repo.lastScannedAt,
        contextCount: contextCounts.get(repo.name) ?? 0,
        currentBranch: branchInfo.currentBranch,
        behindCount: branchInfo.behindCount,
        defaultBranch: branchInfo.defaultBranch,
        exists,
      };
    }),
  );

  return results;
}
