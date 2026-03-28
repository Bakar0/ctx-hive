/** Human-readable display labels for pipeline stages. */
export const STAGE_LABELS: Record<string, string> = {
  ingest: "Load Data",
  prepare: "Prepare Data",
  extract: "Extract Memories",
  evaluate: "Score Memories",
  "hippocampal-replay": "Hippocampal Replay",
  summarize: "Finalize",
};
