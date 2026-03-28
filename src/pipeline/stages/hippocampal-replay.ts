import { join, basename } from "node:path";
import { buildReplayPrompt, type ReplayContext } from "../../ctx/init.ts";
import { loadIndex, hiveRoot } from "../../ctx/store.ts";
import { runSingle } from "../../adapter/agent-runner.ts";
import type { StageDef } from "../schema.ts";
import type { SessionExtractOutput, EvaluationOutput, SessionIngestOutput } from "./session.ts";
import type { GitExtractOutput } from "./git.ts";
import type { RepoExtractOutput } from "./repo.ts";

// ── Constants ────────────────────────────────────────────────────────

const AGENT_MODEL = "sonnet";
const AGENT_TOOLS = ["Bash", "Read", "Glob", "Grep"];
const LOGS_DIR = join(hiveRoot(), "logs");

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

export interface RepoReplayOutput extends ReplayOutput {
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

    const existing = loadIndex().filter(
      (e) => e.project === meta.name || e.title.toLowerCase().includes(meta.name.toLowerCase()),
    );

    const replayContext: ReplayContext = {
      type: "session",
      transcriptPaths: [transcriptPath],
    };

    const prompt = buildReplayPrompt(meta, existing, replayContext);
    const countBefore = loadIndex().length;

    const result = await runSingle({
      name: `pipeline-replay-${meta.name}`,
      options: {
        name: `pipeline-replay-${meta.name}`,
        prompt,
        cwd,
        model: AGENT_MODEL,
        allowedTools: AGENT_TOOLS,
        logsDir: LOGS_DIR,
      },
    });

    const countAfter = loadIndex().length;
    const taskResult = result.results[0];

    ctx.setMetrics({
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      costUsd: taskResult?.cost_usd,
    });

    if (taskResult?.error != null && taskResult.error !== "") {
      throw new Error(taskResult.error);
    }

    const entriesDeleted = Math.max(0, countBefore - countAfter);

    return {
      resultText: taskResult?.resultText,
      costUsd: taskResult?.cost_usd ?? 0,
      entriesDeleted,
      entriesUpdated: 0, // TODO: track via agent output parsing
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      extract: input.extract,
      evaluate: input.evaluate,
    };
  },
};

// ── Git Replay Stage ─────────────────────────────────────────────────
// Runs after extract in git-push / git-pull pipelines

export const gitReplayStage: StageDef<GitExtractOutput, GitReplayOutput> = {
  name: "hippocampal-replay",
  retries: 1,
  retryDelayMs: 30_000,
  condition: (input) => input.existingCount > 0,
  async run(input, ctx) {
    const { meta, repoPath, changeDetails } = input;

    const existing = loadIndex().filter(
      (e) => e.project === meta.name || e.title.toLowerCase().includes(meta.name.toLowerCase()),
    );

    const replayContext: ReplayContext = {
      type: "git-push", // covers both push and pull — the changeDetails has the real trigger
      changeDetails,
    };

    const prompt = buildReplayPrompt(meta, existing, replayContext);
    const countBefore = loadIndex().length;

    const result = await runSingle({
      name: `pipeline-replay-${basename(repoPath)}`,
      options: {
        name: `pipeline-replay-${basename(repoPath)}`,
        prompt,
        cwd: repoPath,
        model: AGENT_MODEL,
        allowedTools: AGENT_TOOLS,
        logsDir: LOGS_DIR,
      },
    });

    const countAfter = loadIndex().length;
    const taskResult = result.results[0];

    ctx.setMetrics({
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      costUsd: taskResult?.cost_usd,
    });

    if (taskResult?.error != null && taskResult.error !== "") {
      throw new Error(taskResult.error);
    }

    const entriesDeleted = Math.max(0, countBefore - countAfter);

    return {
      resultText: taskResult?.resultText,
      costUsd: taskResult?.cost_usd ?? 0,
      entriesDeleted,
      entriesUpdated: 0,
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      success: input.success,
      entriesCreated: input.entriesCreated,
      extractInputTokens: input.inputTokens,
      extractOutputTokens: input.outputTokens,
    };
  },
};

// ── Repo Replay Stage ────────────────────────────────────────────────
// Runs after extract in repo-sync pipeline

export const repoReplayStage: StageDef<RepoExtractOutput, RepoReplayOutput> = {
  name: "hippocampal-replay",
  retries: 1,
  retryDelayMs: 30_000,
  condition: (input) => input.existingCount > 0,
  async run(input, ctx) {
    const { meta, repoPath, repoContext } = input;

    const existing = loadIndex().filter(
      (e) => e.project === meta.name || e.title.toLowerCase().includes(meta.name.toLowerCase()),
    );

    const replayContext: ReplayContext = {
      type: "repo-sync",
      repoContext,
    };

    const prompt = buildReplayPrompt(meta, existing, replayContext);
    const countBefore = loadIndex().length;

    const result = await runSingle({
      name: `pipeline-replay-${basename(repoPath)}`,
      options: {
        name: `pipeline-replay-${basename(repoPath)}`,
        prompt,
        cwd: repoPath,
        model: AGENT_MODEL,
        allowedTools: AGENT_TOOLS,
        logsDir: LOGS_DIR,
      },
    });

    const countAfter = loadIndex().length;
    const taskResult = result.results[0];

    ctx.setMetrics({
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      costUsd: taskResult?.cost_usd,
    });

    if (taskResult?.error != null && taskResult.error !== "") {
      throw new Error(taskResult.error);
    }

    const entriesDeleted = Math.max(0, countBefore - countAfter);

    return {
      resultText: taskResult?.resultText,
      costUsd: taskResult?.cost_usd ?? 0,
      entriesDeleted,
      entriesUpdated: 0,
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      success: input.success,
      entriesCreated: input.entriesCreated,
      extractInputTokens: input.inputTokens,
      extractOutputTokens: input.outputTokens,
    };
  },
};
