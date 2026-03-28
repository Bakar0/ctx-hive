import type { PipelineDef } from "./schema.ts";
import { sessionIngestStage, prepareStage, sessionExtractStage, evaluationStage, summarizeStage } from "./stages/session.ts";
import { gitIngestStage, gitPrepareStage, gitExtractStage, gitSummarizeStage } from "./stages/git.ts";
import { repoIngestStage, repoPrepareStage, repoExtractStage, repoSummarizeStage } from "./stages/repo.ts";
import { sessionReplayStage, gitReplayStage, repoReplayStage } from "./stages/hippocampal-replay.ts";

// ── Session Mining Pipeline ──────────────────────────────────────────
// Trigger: SessionEnd hook → session-mine job
// Flow: ingest → prepare → [extract + evaluate] → hippocampal-replay → summarize

export const sessionMinePipeline: PipelineDef = {
  name: "session-mine",
  steps: [
    { type: "serial", stage: sessionIngestStage },
    { type: "serial", stage: prepareStage },
    { type: "parallel", stages: [sessionExtractStage, evaluationStage] },
    { type: "serial", stage: sessionReplayStage },
    { type: "serial", stage: summarizeStage },
  ],
};

// ── Git Push Pipeline ────────────────────────────────────────────────
// Trigger: pre-push hook → git-push job
// Flow: ingest → prepare → extract → hippocampal-replay → summarize

export const gitPushPipeline: PipelineDef = {
  name: "git-push",
  steps: [
    { type: "serial", stage: gitIngestStage },
    { type: "serial", stage: gitPrepareStage },
    { type: "serial", stage: gitExtractStage },
    { type: "serial", stage: gitReplayStage },
    { type: "serial", stage: gitSummarizeStage },
  ],
};

// ── Git Pull Pipeline ────────────────────────────────────────────────
// Trigger: post-merge/post-rewrite hook → git-pull job
// Flow: ingest → prepare → extract → hippocampal-replay → summarize

export const gitPullPipeline: PipelineDef = {
  name: "git-pull",
  steps: [
    { type: "serial", stage: gitIngestStage },
    { type: "serial", stage: gitPrepareStage },
    { type: "serial", stage: gitExtractStage },
    { type: "serial", stage: gitReplayStage },
    { type: "serial", stage: gitSummarizeStage },
  ],
};

// ── Repo Sync Pipeline ───────────────────────────────────────────────
// Trigger: ctx-hive init / repos/sync API → repo-sync job
// Flow: ingest → prepare → extract → hippocampal-replay → summarize

export const repoSyncPipeline: PipelineDef = {
  name: "repo-sync",
  steps: [
    { type: "serial", stage: repoIngestStage },
    { type: "serial", stage: repoPrepareStage },
    { type: "serial", stage: repoExtractStage },
    { type: "serial", stage: repoReplayStage },
    { type: "serial", stage: repoSummarizeStage },
  ],
};

// ── Pipeline registry ────────────────────────────────────────────────

export const pipelineRegistry: Record<string, PipelineDef> = {
  "session-mine": sessionMinePipeline,
  "git-push": gitPushPipeline,
  "git-pull": gitPullPipeline,
  "repo-sync": repoSyncPipeline,
};
