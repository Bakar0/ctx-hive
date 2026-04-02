import { basename } from "node:path";
import {
  resolveRepoMeta,
  gatherRepoContext,
  buildUnifiedExtractPrompt,
  checkExistingMemories,
  findProjectOverview,
  type GitChangeDetails,
  type RepoContext,
  type DiffContext,
} from "../../ctx/init.ts";
import { loadIndex, type IndexEntry } from "../../ctx/store.ts";
import { runSingle } from "../../adapter/agent-runner.ts";
import { runGit } from "../../git/run.ts";
import type { StageDef } from "../schema.ts";
import type { GitReplayOutput } from "./hippocampal-replay.ts";
import { AGENT_MODEL, AGENT_TOOLS, LOGS_DIR } from "./constants.ts";

// ── Stage: Ingest ───────────────────────────────────────────────────

export interface GitIngestInput {
  // Unified fields (worktree-based)
  repoPath: string;
  worktreePath?: string;
  branch?: string;
  previousSha?: string;
  currentSha?: string;
  commitMessages?: string;
  changedFiles?: string;
  diffSummary?: string;
  // Legacy fields (hook-based, kept for backward compat)
  type?: "git-push" | "git-pull" | "git-change";
  headSha?: string;
  trigger?: "push" | "pull-merge" | "pull-rebase";
  refs?: Array<{ localSha: string; remoteSha: string }>;
}

export interface GitIngestOutput {
  repoPath: string;
  worktreePath: string;
  meta: { name: string; org: string; remoteUrl: string };
  repoContext: RepoContext;
  index: IndexEntry[];
  existing: IndexEntry[];
  overviewEntry: IndexEntry | null;
  changeDetails: GitChangeDetails;
  isFirstScan: boolean;
}

export const gitIngestStage: StageDef<GitIngestInput, GitIngestOutput> = {
  name: "ingest",
  async run(input, ctx) {
    const { repoPath } = input;
    const worktreePath = input.worktreePath ?? repoPath;

    const meta = await resolveRepoMeta(repoPath);
    const repoContext = await gatherRepoContext(worktreePath);
    const index = loadIndex();
    const existing = checkExistingMemories(meta.name, index);
    const overviewEntry = findProjectOverview(meta.name, index);

    // Determine if this is a first scan or incremental
    const isFirstScan = input.previousSha === undefined || input.previousSha === "";
    const trigger: GitChangeDetails["trigger"] = "remote-change";

    // Use pre-computed diffs from the job payload (or compute for legacy paths)
    let commitMessages = input.commitMessages ?? "";
    let changedFiles = input.changedFiles ?? "";
    let diffSummary = input.diffSummary ?? "";

    // Legacy path: compute diffs if not pre-computed (git-push/git-pull)
    if (commitMessages === "" && changedFiles === "" && !isFirstScan && input.type !== "git-change") {
      let diffRange: string;
      if (input.type === "git-push" && input.refs !== undefined && input.refs.length > 0) {
        const ref = input.refs[0]!;
        const isNewBranch = ref.remoteSha === "0000000000000000000000000000000000000000";
        diffRange = isNewBranch ? "HEAD~10..HEAD" : `${ref.remoteSha}..${ref.localSha}`;
      } else if (input.type === "git-pull") {
        diffRange = "ORIG_HEAD..HEAD";
      } else {
        diffRange = `${input.previousSha}..${input.currentSha}`;
      }
      [commitMessages, changedFiles, diffSummary] = await Promise.all([
        runGit(["log", "--oneline", diffRange], worktreePath),
        runGit(["diff", "--name-status", diffRange], worktreePath),
        runGit(["diff", "--stat", diffRange], worktreePath),
      ]);
    }

    ctx.setMetrics({ itemsProcessed: 1 });

    return {
      repoPath,
      worktreePath,
      meta,
      repoContext,
      index,
      existing,
      overviewEntry,
      isFirstScan,
      changeDetails: { trigger, commitMessages, changedFiles, diffSummary },
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
  worktreePath: string;
  repoContext: RepoContext;
  changeDetails: GitChangeDetails;
  existingCount: number;
}

export const gitExtractStage: StageDef<GitIngestOutput, GitExtractOutput> = {
  name: "extract",
  retries: 1,
  retryDelayMs: 30_000,
  condition: (input) => {
    // Always run for first scan; skip incremental if nothing changed
    if (input.isFirstScan) return true;
    const d = input.changeDetails;
    return d.commitMessages !== "" || d.changedFiles !== "";
  },
  async run(input, ctx) {
    const { meta, repoContext, existing, overviewEntry, changeDetails, repoPath, worktreePath, index, isFirstScan } = input;

    const diff: DiffContext | null = isFirstScan ? null : {
      commitMessages: changeDetails.commitMessages,
      changedFiles: changeDetails.changedFiles,
      diffSummary: changeDetails.diffSummary,
    };

    const prompt = buildUnifiedExtractPrompt(meta, repoContext, existing, overviewEntry, diff);
    const countBefore = index.length;

    const result = await runSingle({
      name: `pipeline-extract-${basename(repoPath)}`,
      options: {
        name: `pipeline-extract-${basename(repoPath)}`,
        prompt,
        cwd: worktreePath,
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
      meta,
      repoPath,
      worktreePath,
      repoContext,
      changeDetails,
      existingCount: existing.length,
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
