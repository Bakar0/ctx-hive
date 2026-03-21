import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { hiveRoot } from "../ctx/store.ts";
import { resolveRepoMeta } from "../ctx/init.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface TrackedRepo {
  name: string;
  absPath: string;
  org: string;
  remoteUrl: string;
  trackedAt: string;
  lastScannedAt?: string;
}

interface RepoStore {
  repos: TrackedRepo[];
  updatedAt: string;
}

// ── Paths ──────────────────────────────────────────────────────────────

export function reposJsonPath(): string {
  return join(hiveRoot(), "repos.json");
}

// ── Load / Save ────────────────────────────────────────────────────────

export async function loadTrackedRepos(): Promise<TrackedRepo[]> {
  const file = Bun.file(reposJsonPath());
  if (!(await file.exists())) return [];
  try {
    const raw: unknown = await file.json();
    // oxlint-disable-next-line no-unsafe-type-assertion -- repos.json schema
    const data = raw as RepoStore;
    return data.repos ?? [];
  } catch {
    return [];
  }
}

export async function saveTrackedRepos(repos: TrackedRepo[]): Promise<void> {
  const store: RepoStore = {
    repos,
    updatedAt: new Date().toISOString(),
  };
  await Bun.write(reposJsonPath(), JSON.stringify(store, null, 2));
}

// ── Track / Untrack ────────────────────────────────────────────────────

export async function trackRepo(absPath: string): Promise<TrackedRepo> {
  const normalized = resolve(absPath);

  // Validate the path exists and has .git
  try {
    const gitStat = await stat(join(normalized, ".git"));
    if (!gitStat.isDirectory()) {
      throw new Error(`Not a git repository: ${normalized}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Not a git")) throw err;
    throw new Error(`Not a git repository or path not found: ${normalized}`);
  }

  const repos = await loadTrackedRepos();

  // Dedup by absPath
  const existing = repos.find((r) => r.absPath === normalized);
  if (existing) return existing;

  const meta = await resolveRepoMeta(normalized);
  const tracked: TrackedRepo = {
    name: meta.name,
    absPath: normalized,
    org: meta.org,
    remoteUrl: meta.remoteUrl,
    trackedAt: new Date().toISOString(),
  };

  repos.push(tracked);
  await saveTrackedRepos(repos);
  return tracked;
}

export async function untrackRepo(absPath: string): Promise<boolean> {
  const normalized = resolve(absPath);
  const repos = await loadTrackedRepos();
  const idx = repos.findIndex((r) => r.absPath === normalized);
  if (idx === -1) return false;
  repos.splice(idx, 1);
  await saveTrackedRepos(repos);
  return true;
}

export async function isTracked(absPath: string): Promise<boolean> {
  const normalized = resolve(absPath);
  const repos = await loadTrackedRepos();
  return repos.some((r) => r.absPath === normalized);
}

export async function updateLastScanned(absPath: string): Promise<void> {
  const normalized = resolve(absPath);
  const repos = await loadTrackedRepos();
  const repo = repos.find((r) => r.absPath === normalized);
  if (!repo) return;
  repo.lastScannedAt = new Date().toISOString();
  await saveTrackedRepos(repos);
}
