import { basename } from "node:path";
import { buildReplayPrompt, checkExistingMemories, type ReplayContext } from "../../ctx/init.ts";
import { countRevisionActions } from "../../ctx/store.ts";
import { runSingle } from "../../adapter/agent-runner.ts";
import type { StageDef } from "../schema.ts";
import type { SessionExtractOutput, EvaluationOutput, SessionIngestOutput } from "./session.ts";
import type { GitExtractOutput } from "./git.ts";
import { AGENT_MODEL, AGENT_TOOLS, LOGS_DIR } from "./constants.ts";

// ── Output types ─────────────────────────────────────────────────────

export interface ReplayOutput {
  resultText: string | undefined;
  costUsd: number;
  entriesDeleted: number;
  entriesUpdated: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

export interface SessionReplayOutput extends ReplayOutput {
  extract: SessionExtractOutput;
  evaluate: EvaluationOutput | SessionIngestOutput;
}

export interface GitReplayOutput extends ReplayOutput {
  // Passthrough from extract
  success: boolean;
  entriesCreated: number;
  extractInputTokens: number | undefined;
  extractOutputTokens: number | undefined;
}

// ── Session Replay Stage ─────────────────────────────────────────────
// Runs after [extract + evaluate] parallel step in session-mine pipeline

interface SessionReplayInput {
  extract: SessionExtractOutput;
  evaluate: EvaluationOutput | SessionIngestOutput;
}

export const sessionReplayStage: StageDef<SessionReplayInput, SessionReplayOutput> = {
  name: "hippocampal-replay",
  retries: 1,
  retryDelayMs: 30_000,
  condition: (input) => input.extract.existingCount > 0,
  async run(input, ctx) {
    const { meta, cwd, transcriptPath } = input.extract;

    const existing = checkExistingMemories(meta.name);

    const replayContext: ReplayContext = {
      type: "session",
      transcriptPaths: [transcriptPath],
    };

    const prompt = buildReplayPrompt(meta, existing, replayContext);

    const result = await runSingle({
      name: `pipeline-replay-${meta.name}`,
      options: {
        name: `pipeline-replay-${meta.name}`,
        prompt,
        cwd,
        model: AGENT_MODEL,
        allowedTools: AGENT_TOOLS,
        logsDir: LOGS_DIR,
        env: { CTX_HIVE_EXECUTION_ID: ctx.executionId },
      },
    });

    const taskResult = result.results[0];

    ctx.setMetrics({
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      costUsd: taskResult?.cost_usd,
    });

    if (taskResult?.error != null && taskResult.error !== "") {
      throw new Error(taskResult.error);
    }

    const revisionCounts = countRevisionActions(ctx.executionId);
    const entriesDeleted = revisionCounts.deleted ?? 0;
    const entriesUpdated = revisionCounts.updated ?? 0;

    return {
      resultText: taskResult?.resultText,
      costUsd: taskResult?.cost_usd ?? 0,
      entriesDeleted,
      entriesUpdated,
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      extract: input.extract,
      evaluate: input.evaluate,
    };
  },
};

// ── Git Replay Stage ─────────────────────────────────────────────────
// Unified replay stage — runs after extract with cwd = worktree.
// Provides both change details and repo context to the replay agent.

export const gitReplayStage: StageDef<GitExtractOutput, GitReplayOutput> = {
  name: "hippocampal-replay",
  retries: 1,
  retryDelayMs: 30_000,
  condition: (input) => input.existingCount > 0,
  async run(input, ctx) {
    const { meta, repoPath, worktreePath, changeDetails, repoContext } = input;

    const existing = checkExistingMemories(meta.name);

    const replayContext: ReplayContext = {
      type: "git-change",
      changeDetails,
      repoContext,
    };

    const prompt = buildReplayPrompt(meta, existing, replayContext);

    const result = await runSingle({
      name: `pipeline-replay-${basename(repoPath)}`,
      options: {
        name: `pipeline-replay-${basename(repoPath)}`,
        prompt,
        cwd: worktreePath,
        model: AGENT_MODEL,
        allowedTools: AGENT_TOOLS,
        logsDir: LOGS_DIR,
        env: { CTX_HIVE_EXECUTION_ID: ctx.executionId },
      },
    });

    const taskResult = result.results[0];

    ctx.setMetrics({
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      costUsd: taskResult?.cost_usd,
    });

    if (taskResult?.error != null && taskResult.error !== "") {
      throw new Error(taskResult.error);
    }

    const revisionCounts = countRevisionActions(ctx.executionId);
    const entriesDeleted = revisionCounts.deleted ?? 0;
    const entriesUpdated = revisionCounts.updated ?? 0;

    return {
      resultText: taskResult?.resultText,
      costUsd: taskResult?.cost_usd ?? 0,
      entriesDeleted,
      entriesUpdated,
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      success: input.success,
      entriesCreated: input.entriesCreated,
      extractInputTokens: input.inputTokens,
      extractOutputTokens: input.outputTokens,
    };
  },
};
