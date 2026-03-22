import { join } from "node:path";
import { resolveRepoMeta, buildSessionPrompt, buildGitChangePrompt, buildRepoPrompt, gatherRepoContext, type GitChangeDetails } from "../ctx/init.ts";
import { loadIndex, hiveRoot, type IndexEntry } from "../ctx/store.ts";
import { runSingle } from "../adapter/pipeline.ts";
import { runGit } from "../git/run.ts";
import type { Job, JobResult } from "./jobs.ts";

// ── Constants ────────────────────────────────────────────────────────

const AGENT_MODEL = "sonnet";
const AGENT_TOOLS = ["Bash", "Read", "Glob", "Grep"];
const LOGS_DIR = join(hiveRoot(), "logs");

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

// ── Shared agent runner ──────────────────────────────────────────────

async function runAgentAndCollect(
  name: string,
  prompt: string,
  cwd: string,
  index: IndexEntry[],
  extra?: { transcriptTokens?: number },
): Promise<JobResult> {
  const start = Date.now();
  const countBefore = index.length;

  const result = await runSingle({
    name,
    options: {
      name,
      prompt,
      cwd,
      model: AGENT_MODEL,
      allowedTools: AGENT_TOOLS,
      logsDir: LOGS_DIR,
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
      ...extra,
    };
  }

  return {
    success: true,
    duration_ms,
    entriesCreated,
    inputTokens: taskResult?.inputTokens,
    outputTokens: taskResult?.outputTokens,
    ...extra,
  };
}

// ── Session-mine handler ──────────────────────────────────────────────

async function handleSessionMine(job: Job): Promise<JobResult> {
  if (job.type !== "session-mine") throw new Error("Expected session-mine job");
  const { cwd, transcriptPath } = job;

  // Estimate transcript token count from file size
  let transcriptTokens: number | undefined;
  try {
    const file = Bun.file(transcriptPath);
    transcriptTokens = Math.round(file.size / 4);
  } catch {
    // skip if unreadable
  }

  const meta = await resolveRepoMeta(cwd);
  const index = await loadIndex();
  const existing = index.filter(
    (e) => e.project === meta.name || e.title.toLowerCase().includes(meta.name.toLowerCase()),
  );
  const isUpdate = existing.length > 0;
  const prompt = buildSessionPrompt(meta, [transcriptPath], existing, isUpdate);

  return runAgentAndCollect(
    `daemon-session-mine-${meta.name}`,
    prompt,
    cwd,
    index,
    { transcriptTokens },
  );
}

// ── Git change handler ───────────────────────────────────────────────

async function handleGitChange(job: Job): Promise<JobResult> {
  if (job.type !== "git-push" && job.type !== "git-pull") throw new Error("Expected git job");
  const repoPath = job.repoPath;

  const meta = await resolveRepoMeta(repoPath);
  const index = await loadIndex();
  const existing = index.filter(
    (e) => e.project === meta.name || e.title.toLowerCase().includes(meta.name.toLowerCase()),
  );
  const isUpdate = existing.length > 0;

  // Determine diff range based on job type
  let diffRange: string;
  let trigger: GitChangeDetails["trigger"];

  if (job.type === "git-push") {
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
    diffRange = "ORIG_HEAD..HEAD";
  }

  // Gather change details
  const [commitMessages, changedFiles, diffSummary] = await Promise.all([
    runGit(["log", "--oneline", diffRange], repoPath),
    runGit(["diff", "--name-status", diffRange], repoPath),
    runGit(["diff", "--stat", diffRange], repoPath),
  ]);

  // Skip if nothing changed
  if (!commitMessages && !changedFiles) {
    return { success: true, duration_ms: 0, entriesCreated: 0 };
  }

  const overviewEntry = index.find(
    (e) => e.project === meta.name && e.tags.includes("project-overview"),
  ) ?? null;

  const prompt = buildGitChangePrompt(meta, existing, isUpdate, {
    trigger,
    commitMessages,
    changedFiles,
    diffSummary,
  }, overviewEntry);

  return runAgentAndCollect(
    `daemon-git-${job.type}-${meta.name}`,
    prompt,
    repoPath,
    index,
  );
}

// ── Repo sync handler ────────────────────────────────────────────────

async function handleRepoSync(job: Job): Promise<JobResult> {
  if (job.type !== "repo-sync") throw new Error("Expected repo-sync job");
  const repoPath = job.repoPath;

  const meta = await resolveRepoMeta(repoPath);
  const repoContext = await gatherRepoContext(repoPath);
  const index = await loadIndex();
  const existing = index.filter(
    (e) => e.project === meta.name || e.title.toLowerCase().includes(meta.name.toLowerCase()),
  );
  const isUpdate = existing.length > 0;
  const overviewEntry = index.find(
    (e) => e.project === meta.name && e.tags.includes("project-overview"),
  ) ?? null;

  const prompt = buildRepoPrompt(meta, repoContext, existing, isUpdate, overviewEntry);

  return runAgentAndCollect(
    `daemon-repo-sync-${meta.name}`,
    prompt,
    repoPath,
    index,
  );
}

// ── Register built-in handlers ────────────────────────────────────────

registerHandler("session-mine", handleSessionMine);
registerHandler("git-push", handleGitChange);
registerHandler("git-pull", handleGitChange);
registerHandler("repo-sync", handleRepoSync);
