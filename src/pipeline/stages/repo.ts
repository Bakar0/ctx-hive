import { join, basename } from "node:path";
import { resolveRepoMeta, gatherRepoContext, buildRepoPrompt } from "../../ctx/init.ts";
import { loadIndex, hiveRoot, type IndexEntry } from "../../ctx/store.ts";
import { runSingle } from "../../adapter/agent-runner.ts";
import type { StageDef } from "../schema.ts";

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
  isUpdate: boolean;
  overviewEntry: IndexEntry | null;
}

export const repoIngestStage: StageDef<RepoIngestInput, RepoIngestOutput> = {
  name: "ingest",
  async run(input, ctx) {
    const { repoPath } = input;

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

    ctx.setMetrics({ itemsProcessed: 1 });

    return { repoPath, meta, repoContext, index, existing, isUpdate, overviewEntry };
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
}

export const repoExtractStage: StageDef<RepoIngestOutput, RepoExtractOutput> = {
  name: "extract",
  retries: 1,
  retryDelayMs: 30_000,
  async run(input, ctx) {
    const { meta, repoContext, existing, isUpdate, overviewEntry, repoPath, index } = input;

    const prompt = buildRepoPrompt(meta, repoContext, existing, isUpdate, overviewEntry);
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

    const indexAfter = await loadIndex();
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
    };
  },
};

// ── Stage: Summarize ────────────────────────────────────────────────

export interface RepoSummarizeOutput {
  success: boolean;
  entriesCreated: number;
  inputTokens: number;
  outputTokens: number;
}

export const repoSummarizeStage: StageDef<RepoExtractOutput, RepoSummarizeOutput> = {
  name: "summarize",
  async run(input, ctx) {
    ctx.setMetrics({ itemsProcessed: input.entriesCreated });
    return {
      success: input.success,
      entriesCreated: input.entriesCreated,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
    };
  },
};
