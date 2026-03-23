import { join } from "node:path";
import { resolveRepoMeta, buildSessionPrompt, buildEvaluationPrompt, buildGitChangePrompt, buildRepoPrompt, gatherRepoContext, type GitChangeDetails, type ServedEntry } from "../ctx/init.ts";
import { loadIndex, hiveRoot, type IndexEntry } from "../ctx/store.ts";
import { extractServedEntries } from "../ctx/sessions.ts";
import { getSessionEntries } from "../ctx/search-history.ts";
import { runSingle, runParallel, type PipelineTask } from "../adapter/pipeline.ts";
import { runGit } from "../git/run.ts";
import type { Job, JobResult } from "./jobs.ts";

// ── Constants ────────────────────────────────────────────────────────

const AGENT_MODEL = "sonnet";
const AGENT_TOOLS = ["Bash", "Read", "Glob", "Grep"];
const LOGS_DIR = join(hiveRoot(), "logs");

// ── Transcript parsing ──────────────────────────────────────────────

/**
 * Extract the context window size from a Claude Code session transcript.
 * Reads the last assistant message's usage and sums input + cached tokens.
 */
export async function extractTranscriptTokens(transcriptPath: string): Promise<number | undefined> {
  try {
    const text = await Bun.file(transcriptPath).text();
    const lines = text.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const msg: unknown = JSON.parse(lines[i]!);
        if (
          typeof msg !== "object" || msg === null ||
          !("type" in msg) || msg.type !== "assistant" ||
          !("message" in msg) || typeof msg.message !== "object" || msg.message === null ||
          !("usage" in msg.message) || typeof msg.message.usage !== "object" || msg.message.usage === null
        ) continue;
        const u = msg.message.usage;
        const inp = "input_tokens" in u && typeof u.input_tokens === "number" ? u.input_tokens : 0;
        const cacheCreate = "cache_creation_input_tokens" in u && typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
        const cacheRead = "cache_read_input_tokens" in u && typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
        return inp + cacheCreate + cacheRead;
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // skip if unreadable
  }
  return undefined;
}

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

  // Extract context window size from the last assistant message's usage
  const transcriptTokens = await extractTranscriptTokens(transcriptPath);

  const meta = await resolveRepoMeta(cwd);
  const index = await loadIndex();
  const existing = index.filter(
    (e) => e.project === meta.name || e.title.toLowerCase().includes(meta.name.toLowerCase()),
  );
  const isUpdate = existing.length > 0;

  // Find entries that were served in this session — try search-history first, fallback to transcript regex
  const historyEntries = await getSessionEntries(job.sessionId);
  let servedEntries: ServedEntry[];

  if (historyEntries.length > 0) {
    servedEntries = historyEntries
      .map((e) => {
        const entry = index.find((ie) => ie.id === e.id);
        return entry !== undefined ? { id: e.id, title: entry.title } : null;
      })
      .filter((e): e is ServedEntry => e !== null);
  } else {
    // Fallback: regex scan transcript (backward compat for sessions before this change)
    const servedIds = await extractServedEntries(transcriptPath);
    servedEntries = servedIds
      .map((id) => {
        const entry = index.find((e) => e.id === id);
        return entry !== undefined ? { id, title: entry.title } : null;
      })
      .filter((e): e is ServedEntry => e !== null);
  }

  const start = Date.now();
  const countBefore = index.length;

  // Build tasks: always mine, evaluate only if there are served entries
  const tasks: PipelineTask<unknown>[] = [];

  tasks.push({
    name: `daemon-session-mine-${meta.name}`,
    options: {
      name: `daemon-session-mine-${meta.name}`,
      prompt: buildSessionPrompt(meta, [transcriptPath], existing, isUpdate, servedEntries),
      cwd,
      model: AGENT_MODEL,
      allowedTools: AGENT_TOOLS,
      logsDir: LOGS_DIR,
    },
  });

  if (servedEntries.length > 0) {
    tasks.push({
      name: `daemon-session-eval-${meta.name}`,
      options: {
        name: `daemon-session-eval-${meta.name}`,
        prompt: buildEvaluationPrompt(meta, [transcriptPath], servedEntries),
        cwd,
        model: AGENT_MODEL,
        allowedTools: ["Bash", "Read"],
        logsDir: LOGS_DIR,
      },
    });
  }

  const phase = await runParallel(tasks);

  const countAfter = (await loadIndex()).length;
  const entriesCreated = Math.max(0, countAfter - countBefore);
  const duration_ms = Date.now() - start;

  // Sum token usage across all agents
  let inputTokens = 0;
  let outputTokens = 0;
  let hasError = false;
  let errorMsg: string | undefined;

  for (const r of phase.results) {
    inputTokens += r.inputTokens ?? 0;
    outputTokens += r.outputTokens ?? 0;
    if (r.error != null && r.error !== "") {
      hasError = true;
      errorMsg = r.error;
    }
  }

  if (hasError) {
    return {
      success: false,
      error: errorMsg,
      duration_ms,
      entriesCreated,
      inputTokens,
      outputTokens,
      transcriptTokens,
    };
  }

  return {
    success: true,
    duration_ms,
    entriesCreated,
    inputTokens,
    outputTokens,
    transcriptTokens,
  };
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
