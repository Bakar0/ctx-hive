import type { PipelineDef } from "./schema.ts";
import { sessionIngestStage, prepareStage, sessionExtractStage, evaluationStage, summarizeStage } from "./stages/session.ts";
import { gitIngestStage, gitPrepareStage, gitExtractStage, gitSummarizeStage } from "./stages/git.ts";
import { sessionReplayStage, gitReplayStage } from "./stages/hippocampal-replay.ts";

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

// ── Git Pipelines ───────────────────────────────────────────────────
// Unified pipeline for both first-scan and incremental changes.
// Agent runs with cwd = worktree (bare clone), getting clean branch state.

function gitPipeline(name: string): PipelineDef {
  return {
    name,
    steps: [
      { type: "serial", stage: gitIngestStage },
      { type: "serial", stage: gitPrepareStage },
      { type: "serial", stage: gitExtractStage },
      { type: "serial", stage: gitReplayStage },
      { type: "serial", stage: gitSummarizeStage },
    ],
  };
}

export const gitChangePipeline = gitPipeline("git-change");
export const gitPushPipeline = gitPipeline("git-push");   // legacy
export const gitPullPipeline = gitPipeline("git-pull");    // legacy
