import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { hiveRoot } from "../ctx/store.ts";
import { runGit } from "../git/run.ts";

// ── Paths ────────────────────────────────────────────────────────────

export const REPOS_DIR = join(hiveRoot(), "repos");

export function getBareClonePath(repoId: number): string {
  return join(REPOS_DIR, String(repoId), "bare.git");
}

function sanitizeBranchName(branch: string): string {
  return branch.replace(/\//g, "--");
}

export function getWorktreePath(repoId: number, branch: string): string {
  return join(REPOS_DIR, String(repoId), "branches", sanitizeBranchName(branch));
}

// ── Clone lifecycle ──────────────────────────────────────────────────

export async function cloneBare(remoteUrl: string, repoId: number): Promise<void> {
  const barePath = getBareClonePath(repoId);
  await mkdir(join(REPOS_DIR, String(repoId)), { recursive: true });
  await runGit(["clone", "--bare", remoteUrl, barePath], REPOS_DIR);

  // Configure remote tracking refs so origin/<branch> resolves after fetch.
  // By default, bare clones map refs/heads/* → refs/heads/* (no remote tracking).
  // We need refs/heads/* → refs/remotes/origin/* for origin/main to work.
  await runGit(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], barePath);
  await runGit(["fetch", "origin", "--prune"], barePath);
}

export async function removeClone(repoId: number): Promise<void> {
  const repoDir = join(REPOS_DIR, String(repoId));
  await rm(repoDir, { recursive: true, force: true });
}

// ── Worktree management ──────────────────────────────────────────────

export async function addWorktree(repoId: number, branch: string): Promise<string> {
  const barePath = getBareClonePath(repoId);
  const wtPath = getWorktreePath(repoId, branch);
  await mkdir(join(REPOS_DIR, String(repoId), "branches"), { recursive: true });
  await runGit(["worktree", "add", wtPath, `origin/${branch}`], barePath);
  return wtPath;
}

export async function removeWorktree(repoId: number, branch: string): Promise<void> {
  const barePath = getBareClonePath(repoId);
  const wtPath = getWorktreePath(repoId, branch);
  await runGit(["worktree", "remove", "--force", wtPath], barePath);
}

// ── Fetch + update ───────────────────────────────────────────────────

export async function fetchOrigin(repoId: number): Promise<void> {
  const barePath = getBareClonePath(repoId);
  await runGit(["fetch", "origin", "--prune"], barePath);
}

export async function updateWorktree(repoId: number, branch: string): Promise<void> {
  const wtPath = getWorktreePath(repoId, branch);
  await runGit(["reset", "--hard", `origin/${branch}`], wtPath);
}

// ── Ref queries (local, no network) ──────────────────────────────────

export async function getRemoteHeadSha(repoId: number, branch: string): Promise<string | null> {
  const barePath = getBareClonePath(repoId);
  const sha = await runGit(["rev-parse", `origin/${branch}`], barePath);
  return sha !== "" && sha.length >= 40 ? sha : null;
}

export async function detectDefaultBranch(repoId: number): Promise<string | null> {
  const barePath = getBareClonePath(repoId);

  // Try symbolic ref first (works if origin/HEAD is set)
  const output = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], barePath);
  const branch = output.replace(/^origin\//, "");
  if (branch !== "") return branch;

  // Fallback: check common names
  for (const name of ["main", "master"]) {
    const sha = await getRemoteHeadSha(repoId, name);
    if (sha !== null) return name;
  }
  return null;
}

// ── Existence check ──────────────────────────────────────────────────

export async function bareCloneExists(repoId: number): Promise<boolean> {
  const barePath = getBareClonePath(repoId);
  const result = await runGit(["rev-parse", "--is-bare-repository"], barePath);
  return result === "true";
}

// ── Fix existing bare clones ─────────────────────────────────────────

/**
 * Ensure a bare clone has the correct fetch refspec for remote tracking refs.
 * Bare clones created with `git clone --bare` default to +refs/heads/*:refs/heads/*
 * which doesn't create origin/* refs. This fixes them to use refs/remotes/origin/*.
 */
export async function ensureRemoteTrackingRefs(repoId: number): Promise<void> {
  const barePath = getBareClonePath(repoId);
  const currentRefspec = await runGit(["config", "--get", "remote.origin.fetch"], barePath);
  if (currentRefspec === "" || currentRefspec.includes("refs/heads/*:refs/heads/*")) {
    await runGit(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], barePath);
    await runGit(["fetch", "origin", "--prune"], barePath);
  }
}
