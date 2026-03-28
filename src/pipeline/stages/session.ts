import { join } from "node:path";
import { resolveRepoMeta, buildSessionPrompt, buildEvaluationPrompt, type ServedEntry } from "../../ctx/init.ts";
import { loadIndex, hiveRoot, type IndexEntry } from "../../ctx/store.ts";
import { getSessionEntries } from "../../ctx/search-history.ts";
import { runSingle } from "../../adapter/agent-runner.ts";
import type { StageDef } from "../schema.ts";

// ── Constants ────────────────────────────────────────────────────────

const AGENT_MODEL = "sonnet";
const AGENT_TOOLS = ["Bash", "Read", "Glob", "Grep"];
const LOGS_DIR = join(hiveRoot(), "logs");

// ── Transcript token extraction ──────────────────────────────────────

async function extractTranscriptTokens(transcriptPath: string): Promise<number | undefined> {
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

// ── Stage: Ingest ───────────────────────────────────────────────────

export interface SessionIngestInput {
  cwd: string;
  transcriptPath: string;
  sessionId: string;
}

export interface SessionIngestOutput {
  cwd: string;
  transcriptPath: string;
  sessionId: string;
  meta: { name: string; org: string; remoteUrl: string };
  index: IndexEntry[];
  existing: IndexEntry[];
  servedEntries: ServedEntry[];
  transcriptTokens: number | undefined;
}

export const sessionIngestStage: StageDef<SessionIngestInput, SessionIngestOutput> = {
  name: "ingest",
  async run(input, ctx) {
    const { cwd, transcriptPath, sessionId } = input;

    const transcriptTokens = await extractTranscriptTokens(transcriptPath);
    const meta = await resolveRepoMeta(cwd);
    const index = loadIndex();
    const existing = index.filter(
      (e) => e.project === meta.name || e.title.toLowerCase().includes(meta.name.toLowerCase()),
    );
    // Find served entries from search history
    const historyEntries = getSessionEntries(sessionId);
    const servedEntries: ServedEntry[] = historyEntries
      .map((e) => {
        const entry = index.find((ie) => ie.id === e.id);
        return entry !== undefined ? { id: e.id, title: entry.title } : null;
      })
      .filter((e): e is ServedEntry => e !== null);

    ctx.setMetrics({ itemsProcessed: 1 });

    return {
      cwd,
      transcriptPath,
      sessionId,
      meta,
      index,
      existing,
      servedEntries,
      transcriptTokens,
    };
  },
};

// ── Stage: Prepare (observational) ──────────────────────────────────

export interface PrepareOutput {
  injectedEntries: ServedEntry[];
  injectionCount: number;
}

export const prepareStage: StageDef<SessionIngestOutput, SessionIngestOutput & PrepareOutput> = {
  name: "prepare",
  async run(input, ctx) {
    // Observational: report what was injected during this session
    const injectedEntries = input.servedEntries;
    const injectionCount = injectedEntries.length;

    ctx.setMetrics({ itemsProcessed: injectionCount });

    return {
      ...input,
      injectedEntries,
      injectionCount,
    };
  },
};

// ── Stage: Extract ──────────────────────────────────────────────────

export interface SessionExtractOutput {
  resultText: string | undefined;
  costUsd: number;
  createdEntries: { id: string; title: string }[];
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  indexBeforeCount: number;
  // Passthrough for downstream hippocampal-replay stage
  meta: { name: string; org: string; remoteUrl: string };
  cwd: string;
  transcriptPath: string;
  existingCount: number;
}

export const sessionExtractStage: StageDef<SessionIngestOutput & PrepareOutput, SessionExtractOutput> = {
  name: "extract",
  retries: 1,
  retryDelayMs: 30_000,
  async run(input, ctx) {
    const prompt = buildSessionPrompt(
      input.meta,
      [input.transcriptPath],
      input.existing,
      input.servedEntries,
    );

    const idsBefore = new Set(input.index.map((e) => e.id));

    const result = await runSingle({
      name: `pipeline-mine-${input.meta.name}`,
      options: {
        name: `pipeline-mine-${input.meta.name}`,
        prompt,
        cwd: input.cwd,
        model: AGENT_MODEL,
        allowedTools: AGENT_TOOLS,
        logsDir: LOGS_DIR,
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

    const indexAfter = loadIndex();
    const createdEntries = indexAfter
      .filter((e) => !idsBefore.has(e.id))
      .map((e) => ({ id: e.id, title: e.title }));

    return {
      resultText: taskResult?.resultText,
      costUsd: taskResult?.cost_usd ?? 0,
      createdEntries,
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
      indexBeforeCount: input.index.length,
      meta: input.meta,
      cwd: input.cwd,
      transcriptPath: input.transcriptPath,
      existingCount: input.existing.length,
    };
  },
};

// ── Stage: Evaluation ────────────────────────────────────────────────

export interface EvaluationOutput {
  resultText: string | undefined;
  costUsd: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

export const evaluationStage: StageDef<SessionIngestOutput & PrepareOutput, EvaluationOutput> = {
  name: "evaluate",
  retries: 1,
  retryDelayMs: 30_000,
  condition: (input) => input.servedEntries.length > 0,
  async run(input, ctx) {
    const prompt = buildEvaluationPrompt(
      input.meta,
      [input.transcriptPath],
      input.servedEntries,
    );

    const result = await runSingle({
      name: `pipeline-eval-${input.meta.name}`,
      options: {
        name: `pipeline-eval-${input.meta.name}`,
        prompt,
        cwd: input.cwd,
        model: AGENT_MODEL,
        allowedTools: ["Bash", "Read"],
        logsDir: LOGS_DIR,
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

    return {
      resultText: taskResult?.resultText,
      costUsd: taskResult?.cost_usd ?? 0,
      inputTokens: taskResult?.inputTokens,
      outputTokens: taskResult?.outputTokens,
    };
  },
};

// ── Stage: Summarize ────────────────────────────────────────────────

export interface SummarizeInput {
  extract: SessionExtractOutput;
  evaluate: EvaluationOutput | SessionIngestOutput; // evaluate may be skipped (pass-through)
  // Replay metrics (hippocampal-replay stage)
  entriesDeleted: number;
  entriesUpdated: number;
  costUsd: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

export interface SummarizeOutput {
  success: boolean;
  durationMs: number;
  entriesCreated: number;
  entriesDeleted: number;
  entriesUpdated: number;
  inputTokens: number;
  outputTokens: number;
  transcriptTokens: number | undefined;
}

export const summarizeStage: StageDef<SummarizeInput, SummarizeOutput> = {
  name: "summarize",
  async run(input, ctx) {
    const extractResult = input.extract;

    // Count new entries by comparing current index to the count before extraction
    const currentIndex = loadIndex();
    const entriesCreated = Math.max(0, currentIndex.length - extractResult.indexBeforeCount);

    // Aggregate tokens from extraction, evaluation, and replay
    let inputTokens = extractResult.inputTokens ?? 0;
    let outputTokens = extractResult.outputTokens ?? 0;

    const evalResult = input.evaluate;
    if ("costUsd" in evalResult) {
      inputTokens += evalResult.inputTokens ?? 0;
      outputTokens += evalResult.outputTokens ?? 0;
    }

    // Add replay stage tokens
    inputTokens += input.inputTokens ?? 0;
    outputTokens += input.outputTokens ?? 0;

    ctx.setMetrics({ itemsProcessed: entriesCreated });

    return {
      success: true,
      durationMs: 0, // will be set by executor
      entriesCreated,
      entriesDeleted: input.entriesDeleted,
      entriesUpdated: input.entriesUpdated,
      inputTokens,
      outputTokens,
      transcriptTokens: undefined,
    };
  },
};
