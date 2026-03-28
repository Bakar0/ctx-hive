import { join, basename } from "node:path";
import { resolveRepoMeta, gatherRepoContext, buildRepoPrompt } from "../../ctx/init.ts";
import { loadIndex, hiveRoot, type IndexEntry } from "../../ctx/store.ts";
import { runSingle } from "../../adapter/agent-runner.ts";
import type { StageDef } from "../schema.ts";
import type { RepoReplayOutput } from "./hippocampal-replay.ts";

// ── Constants ────────────────────────────────────────────────────────

const AGENT_MODEL = "sonnet";
const AGENT_TOOLS = ["Bash", "Read", "Glob", "Grep"];
const LOGS_DIR = join(hiveRoot(), "logs");

// ── Stage: Ingest ───────────────────────────────────────────────────

export interface RepoIngestInput {
  repoPath: string;
}

export interface RepoIngestOutput {
  repoPath: string;
  meta: { name: string; org: string; remoteUrl: string };
  repoContext: { readme: string; claudeMd: string };
  index: IndexEntry[];
  existing: IndexEntry[];
  overviewEntry: IndexEntry | null;
}

export const repoIngestStage: StageDef<RepoIngestInput, RepoIngestOutput> = {
  name: "ingest",
  async run(input, ctx) {
    const { repoPath } = input;

    const meta = await resolveRepoMeta(repoPath);
    const repoContext = await gatherRepoContext(repoPath);
    const index = loadIndex();
    const existing = index.filter(
      (e) => e.project === meta.name || e.title.toLowerCase().includes(meta.name.toLowerCase()),
    );
    const overviewEntry = index.find(
      (e) => e.project === meta.name && e.tags.includes("project-overview"),
    ) ?? null;

    ctx.setMetrics({ itemsProcessed: 1 });

    return { repoPath, meta, repoContext, index, existing, overviewEntry };
  },
};

// ── Stage: Prepare (observational) ──────────────────────────────────

export interface RepoPrepareOutput {
  existingEntries: { id: string; title: string }[];
  existingCount: number;
}

export const repoPrepareStage: StageDef<RepoIngestOutput, RepoIngestOutput & RepoPrepareOutput> = {
  name: "prepare",
  async run(input, ctx) {
    const existingEntries = input.existing.map((e) => ({ id: e.id, title: e.title }));
    ctx.setMetrics({ itemsProcessed: existingEntries.length });
    return { ...input, existingEntries, existingCount: existingEntries.length };
  },
};

// ── Stage: Extract ──────────────────────────────────────────────────

export interface RepoExtractOutput {
  success: boolean;
  durationMs: number;
  entriesCreated: number;
  createdEntries: { id: string; title: string }[];
  resultText: string | undefined;
  costUsd: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  // Passthrough for downstream hippocampal-replay stage
  meta: { name: string; org: string; remoteUrl: string };
  repoPath: string;
  repoContext: { readme: string; claudeMd: string };
  existingCount: number;
}

export const repoExtractStage: StageDef<RepoIngestOutput, RepoExtractOutput> = {
  name: "extract",
  retries: 1,
  retryDelayMs: 30_000,
  async run(input, ctx) {
    const { meta, repoContext, existing, overviewEntry, repoPath, index } = input;

    const prompt = buildRepoPrompt(meta, repoContext, existing, overviewEntry);
    const idsBefore = new Set(index.map((e) => e.id));

    const result = await runSingle({
      name: `pipeline-repo-${basename(repoPath)}`,
      options: {
        name: `pipeline-repo-${basename(repoPath)}`,
        prompt,
        cwd: repoPath,
        model: AGENT_MODEL,
        allowedTools: AGENT_TOOLS,
        logsDir: LOGS_DIR,
      },
    });

    const indexAfter = loadIndex();
    const createdEntries = indexAfter
      .filter((e) => !idsBefore.has(e.id))
      .map((e) => ({ id: e.id, title: e.title }));
    const entriesCreated = createdEntries.length;
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
      createdEntries,
      resultText: taskResult?.resultText,
      costUsd: taskResult?.cost_usd ?? 0,
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      meta,
      repoPath,
      repoContext,
      existingCount: existing.length,
    };
  },
};

// ── Stage: Summarize ────────────────────────────────────────────────

export interface RepoSummarizeOutput {
  success: boolean;
  entriesCreated: number;
  entriesDeleted: number;
  entriesUpdated: number;
  inputTokens: number;
  outputTokens: number;
}

export const repoSummarizeStage: StageDef<RepoReplayOutput, RepoSummarizeOutput> = {
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
