import { basename } from "node:path";
import { resolveRepoMeta, buildGitChangePrompt, checkExistingMemories, findProjectOverview, type GitChangeDetails } from "../../ctx/init.ts";
import { loadIndex, type IndexEntry } from "../../ctx/store.ts";
import { runSingle } from "../../adapter/agent-runner.ts";
import { runGit } from "../../git/run.ts";
import type { StageDef } from "../schema.ts";
import type { GitReplayOutput } from "./hippocampal-replay.ts";
import { AGENT_MODEL, AGENT_TOOLS, LOGS_DIR } from "./constants.ts";

// ── Stage: Ingest ───────────────────────────────────────────────────

export interface GitIngestInput {
  type: "git-push" | "git-pull";
  repoPath: string;
  headSha: string;
  trigger: "push" | "pull-merge" | "pull-rebase";
  refs?: Array<{ localSha: string; remoteSha: string }>;
}

export interface GitIngestOutput {
  repoPath: string;
  meta: { name: string; org: string; remoteUrl: string };
  index: IndexEntry[];
  existing: IndexEntry[];
  overviewEntry: IndexEntry | null;
  changeDetails: GitChangeDetails;
}

export const gitIngestStage: StageDef<GitIngestInput, GitIngestOutput> = {
  name: "ingest",
  async run(input, ctx) {
    const { repoPath, type: jobType, trigger } = input;

    const meta = await resolveRepoMeta(repoPath);
    const index = loadIndex();
    const existing = checkExistingMemories(meta.name, index);
    const overviewEntry = findProjectOverview(meta.name, index);

    // Determine diff range
    let diffRange: string;
    if (jobType === "git-push") {
      if (input.refs !== undefined && input.refs.length > 0) {
        const ref = input.refs[0]!;
        const isNewBranch = ref.remoteSha === "0000000000000000000000000000000000000000";
        diffRange = isNewBranch ? "HEAD~10..HEAD" : `${ref.remoteSha}..${ref.localSha}`;
      } else {
        diffRange = "HEAD~5..HEAD";
      }
    } else {
      diffRange = "ORIG_HEAD..HEAD";
    }

    const [commitMessages, changedFiles, diffSummary] = await Promise.all([
      runGit(["log", "--oneline", diffRange], repoPath),
      runGit(["diff", "--name-status", diffRange], repoPath),
      runGit(["diff", "--stat", diffRange], repoPath),
    ]);

    ctx.setMetrics({ itemsProcessed: 1 });

    return {
      repoPath,
      meta,
      index,
      existing,
      overviewEntry,
      changeDetails: {
        trigger,
        commitMessages,
        changedFiles,
        diffSummary,
      },
    };
  },
};

// ── Stage: Prepare (observational) ──────────────────────────────────

export interface GitPrepareOutput {
  existingEntries: { id: string; title: string }[];
  existingCount: number;
}

export const gitPrepareStage: StageDef<GitIngestOutput, GitIngestOutput & GitPrepareOutput> = {
  name: "prepare",
  async run(input, ctx) {
    const existingEntries = input.existing.map((e) => ({ id: e.id, title: e.title }));
    const existingCount = existingEntries.length;
    ctx.setMetrics({ itemsProcessed: existingCount });
    return { ...input, existingEntries, existingCount };
  },
};

// ── Stage: Extract ──────────────────────────────────────────────────

export interface GitExtractOutput {
  success: boolean;
  durationMs: number;
  entriesCreated: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  // Passthrough for downstream hippocampal-replay stage
  meta: { name: string; org: string; remoteUrl: string };
  repoPath: string;
  changeDetails: GitChangeDetails;
  existingCount: number;
}

export const gitExtractStage: StageDef<GitIngestOutput, GitExtractOutput> = {
  name: "extract",
  retries: 1,
  retryDelayMs: 30_000,
  condition: (input) => {
    // Skip if nothing changed
    const d = input.changeDetails;
    return Boolean(d.commitMessages || d.changedFiles);
  },
  async run(input, ctx) {
    const { meta, existing, overviewEntry, changeDetails, repoPath, index } = input;

    const prompt = buildGitChangePrompt(meta, existing, changeDetails, overviewEntry);
    const countBefore = index.length;

    const result = await runSingle({
      name: `pipeline-git-${basename(repoPath)}`,
      options: {
        name: `pipeline-git-${basename(repoPath)}`,
        prompt,
        cwd: repoPath,
        model: AGENT_MODEL,
        allowedTools: AGENT_TOOLS,
        logsDir: LOGS_DIR,
      },
    });

    const countAfter = loadIndex().length;
    const entriesCreated = Math.max(0, countAfter - countBefore);
    const taskResult = result.results[0];

    ctx.setMetrics({
      itemsProcessed: entriesCreated,
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      costUsd: taskResult?.cost_usd,
    });

    if (taskResult?.error != null && taskResult.error !== "") {
      throw new Error(taskResult.error);
    }

    return {
      success: true,
      durationMs: 0,
      entriesCreated,
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      meta: input.meta,
      repoPath,
      changeDetails,
      existingCount: input.existing.length,
    };
  },
};

// ── Stage: Summarize ────────────────────────────────────────────────

export interface GitSummarizeOutput {
  success: boolean;
  entriesCreated: number;
  entriesDeleted: number;
  entriesUpdated: number;
  inputTokens: number;
  outputTokens: number;
}

export const gitSummarizeStage: StageDef<GitReplayOutput, GitSummarizeOutput> = {
  name: "summarize",
  async run(input, ctx) {
    ctx.setMetrics({ itemsProcessed: input.entriesCreated });
    return {
      success: input.success,
      entriesCreated: input.entriesCreated,
      entriesDeleted: input.entriesDeleted,
      entriesUpdated: input.entriesUpdated,
      inputTokens: (input.extractInputTokens ?? 0) + (input.inputTokens ?? 0),
      outputTokens: (input.extractOutputTokens ?? 0) + (input.outputTokens ?? 0),
    };
  },
};
