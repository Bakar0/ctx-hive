import { basename, join } from "node:path";
import { z } from "zod";
import {
  writeJob,
  jobTimestamp,
  type SessionMineJob,
  type GitPushJob,
  type GitPullJob,
} from "../daemon/jobs.ts";
import { getFlag, readStdin } from "../cli/args.ts";
import { hiveRoot } from "../ctx/store.ts";

const HookPayloadSchema = z.object({
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  reason: z.string().optional(),
});

function jobFilename(prefix: string): string {
  return `${jobTimestamp()}-${prefix}.json`;
}

/** Fire-and-forget HTTP nudge to the daemon so it drains pending jobs immediately. */
async function nudgeDaemon(): Promise<void> {
  try {
    let port = 3939;
    try {
      const content = await Bun.file(join(hiveRoot(), "daemon.port")).text();
      const parsed = parseInt(content.trim(), 10);
      if (parsed > 0) port = parsed;
    } catch { /* port file missing — use default */ }
    await fetch(`http://localhost:${String(port)}/api/jobs/nudge`, {
      method: "POST",
      signal: AbortSignal.timeout(1000),
    });
  } catch { /* daemon may be down — job stays in DB for poll pickup */ }
}

// ── Enqueue entry point ──────────────────────────────────────────────

/**
 * Reads hook payload and writes a job to the DB.
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

  let payload: z.infer<typeof HookPayloadSchema>;
  try {
    payload = HookPayloadSchema.parse(JSON.parse(raw));
  } catch {
    console.error("Invalid JSON on stdin");
    process.exit(1);
  }

  const transcriptFile = Bun.file(payload.transcript_path);
  if (!(await transcriptFile.exists())) {
    process.exit(0);
  }

  const prefix = (payload.session_id ?? "unknown").slice(0, 8);

  const job: SessionMineJob = {
    type: "session-mine",
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
    reason: payload.reason,
    createdAt: new Date().toISOString(),
  };

  writeJob(job, jobFilename(prefix));
  await nudgeDaemon();
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

  writeJob(job, jobFilename(`push-${repoName}`));
  await nudgeDaemon();
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

  writeJob(job, jobFilename(`pull-${repoName}`));
  await nudgeDaemon();
}
