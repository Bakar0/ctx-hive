import { join } from "node:path";
import { homedir } from "node:os";
import { resolveRepoMeta, checkExistingContext, findProjectOverview, buildSessionPrompt, buildGitChangePrompt, buildRepoPrompt, gatherRepoContext, type GitChangeDetails } from "../ctx/init.ts";
import { loadIndex } from "../ctx/store.ts";
import { runSingle } from "../adapter/pipeline.ts";
import type { Job, JobResult } from "./jobs.ts";

// ── Handler type ──────────────────────────────────────────────────────

export type JobHandler = (job: Job) => Promise<JobResult>;

// ── Handler registry ──────────────────────────────────────────────────

const handlers = new Map<string, JobHandler>();

export function registerHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

// ── Session-mine handler ──────────────────────────────────────────────

async function handleSessionMine(job: Job): Promise<JobResult> {
  if (job.type !== "session-mine") throw new Error("Expected session-mine job");
  const { cwd, transcriptPath } = job;
  const start = Date.now();

  // Estimate transcript token count from file size
  let transcriptTokens: number | undefined;
  try {
    const file = Bun.file(transcriptPath);
    if (await file.exists()) {
      transcriptTokens = Math.round(file.size / 4);
    }
  } catch {
    // skip if unreadable
  }

  const meta = await resolveRepoMeta(cwd);
  const existing = await checkExistingContext(meta.name);
  const isUpdate = existing.length > 0;
  const prompt = buildSessionPrompt(meta, [transcriptPath], existing, isUpdate);

  // Snapshot entry count before running agent
  const countBefore = (await loadIndex()).length;

  const logsDir = join(homedir(), ".ctx-hive", "logs");

  const result = await runSingle({
    name: `daemon-session-mine-${meta.name}`,
    options: {
      name: `daemon-session-mine-${meta.name}`,
      prompt,
      cwd,
      model: "sonnet",
      allowedTools: ["Bash", "Read", "Glob", "Grep"],
      logsDir,
    },
  });

  const countAfter = (await loadIndex()).length;
  const entriesCreated = Math.max(0, countAfter - countBefore);

  const taskResult = result.results[0];
  const duration_ms = Date.now() - start;

  if (taskResult?.error != null && taskResult.error !== "") {
    return {
      success: false,
      error: taskResult.error,
      duration_ms,
      transcriptTokens,
      entriesCreated,
      inputTokens: taskResult.inputTokens,
      outputTokens: taskResult.outputTokens,
    };
  }

  return {
    success: true,
    duration_ms,
    transcriptTokens,
    entriesCreated,
    inputTokens: taskResult?.inputTokens,
    outputTokens: taskResult?.outputTokens,
  };
}

// ── Git change handler ───────────────────────────────────────────────

async function getGitOutput(args: string[], cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim();
  } catch {
    return "";
  }
}

async function handleGitChange(job: Job): Promise<JobResult> {
  if (job.type !== "git-push" && job.type !== "git-pull") throw new Error("Expected git job");
  const repoPath = job.repoPath;
  const start = Date.now();

  const meta = await resolveRepoMeta(repoPath);
  const existing = await checkExistingContext(meta.name);
  const isUpdate = existing.length > 0;

  // Determine diff range based on job type
  let diffRange: string;
  let trigger: GitChangeDetails["trigger"];

  if (job.type === "git-push") {
    // For push: use the first ref's remote..local range
    if (job.refs.length > 0) {
      const ref = job.refs[0]!;
      const isNewBranch = ref.remoteSha === "0000000000000000000000000000000000000000";
      diffRange = isNewBranch ? `HEAD~10..HEAD` : `${ref.remoteSha}..${ref.localSha}`;
    } else {
      diffRange = "HEAD~5..HEAD";
    }
    trigger = "push";
  } else {
    trigger = job.trigger === "rebase" ? "pull-rebase" : "pull-merge";
    // For pull: ORIG_HEAD..HEAD shows what was merged/rebased in
    diffRange = "ORIG_HEAD..HEAD";
  }

  // Gather change details
  const [commitMessages, changedFiles, diffSummary] = await Promise.all([
    getGitOutput(["log", "--oneline", diffRange], repoPath),
    getGitOutput(["diff", "--name-status", diffRange], repoPath),
    getGitOutput(["diff", "--stat", diffRange], repoPath),
  ]);

  // Skip if nothing changed
  if (!commitMessages && !changedFiles) {
    return { success: true, duration_ms: Date.now() - start, entriesCreated: 0 };
  }

  const overviewEntry = await findProjectOverview(meta.name);

  const prompt = buildGitChangePrompt(meta, existing, isUpdate, {
    trigger,
    commitMessages,
    changedFiles,
    diffSummary,
  }, overviewEntry);

  const countBefore = (await loadIndex()).length;
  const logsDir = join(homedir(), ".ctx-hive", "logs");

  const result = await runSingle({
    name: `daemon-git-${job.type}-${meta.name}`,
    options: {
      name: `daemon-git-${job.type}-${meta.name}`,
      prompt,
      cwd: repoPath,
      model: "sonnet",
      allowedTools: ["Bash", "Read", "Glob", "Grep"],
      logsDir,
    },
  });

  const countAfter = (await loadIndex()).length;
  const entriesCreated = Math.max(0, countAfter - countBefore);
  const taskResult = result.results[0];
  const duration_ms = Date.now() - start;

  if (taskResult?.error != null && taskResult.error !== "") {
    return {
      success: false,
      error: taskResult.error,
      duration_ms,
      entriesCreated,
      inputTokens: taskResult.inputTokens,
      outputTokens: taskResult.outputTokens,
    };
  }

  return {
    success: true,
    duration_ms,
    entriesCreated,
    inputTokens: taskResult?.inputTokens,
    outputTokens: taskResult?.outputTokens,
  };
}

// ── Repo sync handler ────────────────────────────────────────────────

async function handleRepoSync(job: Job): Promise<JobResult> {
  if (job.type !== "repo-sync") throw new Error("Expected repo-sync job");
  const repoPath = job.repoPath;
  const start = Date.now();

  const meta = await resolveRepoMeta(repoPath);
  const repoContext = await gatherRepoContext(repoPath);
  const existing = await checkExistingContext(meta.name);
  const isUpdate = existing.length > 0;
  const overviewEntry = await findProjectOverview(meta.name);

  const prompt = buildRepoPrompt(meta, repoContext, existing, isUpdate, overviewEntry);

  const countBefore = (await loadIndex()).length;
  const logsDir = join(homedir(), ".ctx-hive", "logs");

  const result = await runSingle({
    name: `daemon-repo-sync-${meta.name}`,
    options: {
      name: `daemon-repo-sync-${meta.name}`,
      prompt,
      cwd: repoPath,
      model: "sonnet",
      allowedTools: ["Bash", "Read", "Glob", "Grep"],
      logsDir,
    },
  });

  const countAfter = (await loadIndex()).length;
  const entriesCreated = Math.max(0, countAfter - countBefore);
  const taskResult = result.results[0];
  const duration_ms = Date.now() - start;

  if (taskResult?.error != null && taskResult.error !== "") {
    return {
      success: false,
      error: taskResult.error,
      duration_ms,
      entriesCreated,
      inputTokens: taskResult.inputTokens,
      outputTokens: taskResult.outputTokens,
    };
  }

  return {
    success: true,
    duration_ms,
    entriesCreated,
    inputTokens: taskResult?.inputTokens,
    outputTokens: taskResult?.outputTokens,
  };
}

// ── Register built-in handlers ────────────────────────────────────────

registerHandler("session-mine", handleSessionMine);
registerHandler("git-push", handleGitChange);
registerHandler("git-pull", handleGitChange);
registerHandler("repo-sync", handleRepoSync);
