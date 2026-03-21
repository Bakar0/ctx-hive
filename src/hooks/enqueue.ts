import { basename } from "node:path";
import {
  ensureJobDirs,
  writeJob,
  PENDING_DIR,
  type SessionMineJob,
  type GitPushJob,
  type GitPullJob,
} from "../daemon/jobs.ts";

interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  reason?: string;
}

// ── Arg helpers ──────────────────────────────────────────────────────

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ── Stdin reader ─────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// ── Job filename helper ──────────────────────────────────────────────

function jobFilename(prefix: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${prefix}.json`;
}

// ── Enqueue entry point ──────────────────────────────────────────────

/**
 * Reads hook payload and writes a job file.
 * Usage: ctx-hive enqueue <job-type> [args...]
 */
export async function enqueue(args: string[]): Promise<void> {
  const jobType = args[0];
  if (jobType == null || jobType === "") {
    console.error("Usage: ctx-hive enqueue <job-type>");
    process.exit(1);
  }

  if (jobType === "session-mine") {
    await enqueueSessionMine();
  } else if (jobType === "git-push") {
    await enqueueGitPush(args.slice(1));
  } else if (jobType === "git-pull") {
    await enqueueGitPull(args.slice(1));
  } else {
    console.error(`Unknown job type: ${jobType}`);
    process.exit(1);
  }
}

// ── session-mine ─────────────────────────────────────────────────────

async function enqueueSessionMine(): Promise<void> {
  const raw = await readStdin();
  if (!raw) {
    console.error("No input received on stdin");
    process.exit(1);
  }

  let payload: HookPayload;
  try {
    const parsed: unknown = JSON.parse(raw);
    // oxlint-disable-next-line no-unsafe-type-assertion -- hook stdin schema
    payload = parsed as HookPayload;
  } catch {
    console.error("Invalid JSON on stdin");
    process.exit(1);
  }

  const transcriptFile = Bun.file(payload.transcript_path);
  if (!(await transcriptFile.exists())) {
    process.exit(0);
  }

  await ensureJobDirs();

  const now = new Date();
  const prefix = (payload.session_id ?? "unknown").slice(0, 8);

  const job: SessionMineJob = {
    type: "session-mine",
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
    reason: payload.reason,
    createdAt: now.toISOString(),
  };

  await writeJob(PENDING_DIR, job, jobFilename(prefix));
}

// ── git-push ─────────────────────────────────────────────────────────

async function enqueueGitPush(args: string[]): Promise<void> {
  const remoteName = getFlag(args, "--remote-name") ?? "";
  const remoteUrl = getFlag(args, "--remote-url") ?? "";
  const repoPath = getFlag(args, "--repo-path");
  const headSha = getFlag(args, "--head-sha") ?? "";

  if (repoPath == null || repoPath === "") {
    console.error("Missing --repo-path");
    process.exit(1);
  }

  const raw = await readStdin();
  const refs: GitPushJob["refs"] = [];
  if (raw) {
    for (const line of raw.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        refs.push({
          localRef: parts[0]!,
          localSha: parts[1]!,
          remoteRef: parts[2]!,
          remoteSha: parts[3]!,
        });
      }
    }
  }

  await ensureJobDirs();

  const repoName = basename(repoPath);
  const job: GitPushJob = {
    type: "git-push",
    repoPath,
    headSha,
    remoteName,
    remoteUrl,
    refs,
    createdAt: new Date().toISOString(),
  };

  await writeJob(PENDING_DIR, job, jobFilename(`push-${repoName}`));
}

// ── git-pull ─────────────────────────────────────────────────────────

async function enqueueGitPull(args: string[]): Promise<void> {
  const triggerFlag = getFlag(args, "--trigger") ?? "merge";
  const trigger = triggerFlag === "rebase" ? "rebase" : "merge";
  const squashFlag = getFlag(args, "--squash");
  const repoPath = getFlag(args, "--repo-path");
  const headSha = getFlag(args, "--head-sha") ?? "";

  if (repoPath == null || repoPath === "") {
    console.error("Missing --repo-path");
    process.exit(1);
  }

  const squash = squashFlag === "1";
  let rewrittenShas: GitPullJob["rewrittenShas"];

  if (trigger === "rebase") {
    const raw = await readStdin();
    if (raw) {
      rewrittenShas = [];
      for (const line of raw.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          rewrittenShas.push({ oldSha: parts[0]!, newSha: parts[1]! });
        }
      }
    }
  }

  await ensureJobDirs();

  const repoName = basename(repoPath);
  const job: GitPullJob = {
    type: "git-pull",
    repoPath,
    headSha,
    trigger,
    squash,
    rewrittenShas,
    createdAt: new Date().toISOString(),
  };

  await writeJob(PENDING_DIR, job, jobFilename(`pull-${repoName}`));
}
