import { generateEmbeddings } from "./embeddings.ts";
import { getVectorSearchConfig } from "./settings.ts";
import { syncEntryEmbedding, getEntriesMissingEmbeddings } from "./vector-search.ts";

// ── Backfill state (module-level for status API) ──────────────────────

export interface BackfillState {
  inProgress: boolean;
  done: number;
  total: number;
  failed: number;
}

let state: BackfillState = { inProgress: false, done: 0, total: 0, failed: 0 };

export function getBackfillState(): BackfillState {
  return { ...state };
}

// ── Backfill ──────────────────────────────────────────────────────────

const BATCH_SIZE = 50;

/**
 * Backfill embeddings for all entries that are missing from vec_entries.
 * Incremental — only processes entries not yet embedded.
 */
export async function backfillEmbeddings(
  onProgress?: (done: number, total: number) => void,
): Promise<BackfillState> {
  if (state.inProgress) return { ...state };

  const config = getVectorSearchConfig();
  if (!config.enabled || config.apiKey === null) {
    return { inProgress: false, done: 0, total: 0, failed: 0 };
  }

  const missing = getEntriesMissingEmbeddings();
  if (missing.length === 0) {
    return { inProgress: false, done: 0, total: 0, failed: 0 };
  }

  state = { inProgress: true, done: 0, total: missing.length, failed: 0 };

  try {
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      const texts = batch.map((e) => `${e.title}\n${e.body}`);

      try {
        const embeddings = await generateEmbeddings(texts, config.apiKey, config.model);

        for (let j = 0; j < batch.length; j++) {
          const entry = batch[j]!;
          const embedding = embeddings[j];
          if (embedding !== undefined) {
            syncEntryEmbedding(entry.id, embedding);
            state.done++;
          } else {
            state.failed++;
          }
        }
      } catch (err) {
        console.error(`[backfill] Batch ${i}-${i + batch.length} failed:`, err);
        state.failed += batch.length;
      }

      onProgress?.(state.done, state.total);
    }
  } finally {
    state.inProgress = false;
  }

  return { ...state };
}
