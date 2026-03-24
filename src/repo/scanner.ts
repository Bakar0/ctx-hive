import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { scanForRepos, resolveRepoMeta } from "../ctx/init.ts";
import { loadIndex, type IndexEntry } from "../ctx/store.ts";
import { loadTrackedRepos, type TrackedRepo } from "./tracking.ts";
import { runGit } from "../git/run.ts";

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
  modifiedCount: number;
  untrackedCount: number;
  defaultBranch: string;
  lastModifiedAt?: string;
  exists: boolean;
}

export async function getRepoBranchInfo(
  repoPath: string,
): Promise<{ currentBranch: string; behindCount: number; modifiedCount: number; untrackedCount: number; defaultBranch: string }> {
  // Run independent git commands in parallel
  const [currentBranch, remoteHead, statusOutput] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath),
    runGit(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], repoPath),
    runGit(["status", "--porcelain"], repoPath),
  ]);

  // Detect default branch from origin
  const defaultBranch = remoteHead ? remoteHead.replace(/^origin\//, "") : "main";

  // Count commits behind (depends on defaultBranch)
  let behindCount = 0;
  const behindStr = await runGit(["rev-list", "--count", `HEAD..origin/${defaultBranch}`], repoPath);
  if (behindStr) {
    const n = parseInt(behindStr, 10);
    if (!Number.isNaN(n)) behindCount = n;
  }

  // Parse working tree status
  let modifiedCount = 0;
  let untrackedCount = 0;
  for (const line of (statusOutput ?? "").split("\n")) {
    if (line.startsWith("??")) untrackedCount++;
    else if (line.length > 0) modifiedCount++;
  }

  return { currentBranch, behindCount, modifiedCount, untrackedCount, defaultBranch };
}

// ── Path helpers ───────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildContextCountMap(index: IndexEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of index) {
    if (entry.project) {
      counts.set(entry.project, (counts.get(entry.project) ?? 0) + 1);
    }
  }
  return counts;
}

// ── Discover repos ─────────────────────────────────────────────────────

export async function discoverRepos(
  rootPath: string,
  maxDepth: number = 4,
): Promise<DiscoveredRepo[]> {
  const root = expandHome(rootPath);

  const index = loadIndex();
  const tracked = loadTrackedRepos();
  const scanned = await scanForRepos(root, maxDepth);

  const contextCounts = buildContextCountMap(index);

  // Build tracked map: absPath -> TrackedRepo
  const trackedMap = new Map<string, TrackedRepo>();
  for (const t of tracked) {
    trackedMap.set(t.absPath, t);
  }

  // Enrich in parallel
  const results = await Promise.all(
    scanned.map(async (repo): Promise<DiscoveredRepo> => {
      const [meta, branchInfo, gitStat] = await Promise.all([
        resolveRepoMeta(repo.absPath),
        getRepoBranchInfo(repo.absPath),
        stat(resolve(repo.absPath, ".git")).catch(() => null),
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
        modifiedCount: branchInfo.modifiedCount,
        untrackedCount: branchInfo.untrackedCount,
        defaultBranch: branchInfo.defaultBranch,
        lastModifiedAt: gitStat?.mtime.toISOString(),
        exists: true,
      };
    }),
  );

  return results;
}

// ── Enrich tracked repos ───────────────────────────────────────────────

export async function enrichTrackedRepos(): Promise<DiscoveredRepo[]> {
  const index = loadIndex();
  const tracked = loadTrackedRepos();

  const contextCounts = buildContextCountMap(index);

  const results = await Promise.all(
    tracked.map(async (repo): Promise<DiscoveredRepo> => {
      let exists = true;
      let gitStat: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        await stat(repo.absPath);
        gitStat = await stat(resolve(repo.absPath, ".git")).catch(() => null);
      } catch {
        exists = false;
      }

      let branchInfo = { currentBranch: "", behindCount: 0, modifiedCount: 0, untrackedCount: 0, defaultBranch: "main" };
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
        modifiedCount: branchInfo.modifiedCount,
        untrackedCount: branchInfo.untrackedCount,
        defaultBranch: branchInfo.defaultBranch,
        lastModifiedAt: gitStat?.mtime.toISOString(),
        exists,
      };
    }),
  );

  return results;
}
