// ── OpenRouter Embeddings API (no SDK) ────────────────────────────────

import { z } from "zod";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMS = 1536;
const MAX_BATCH_SIZE = 100;

export { EMBEDDING_DIMS };

const EmbeddingResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
  model: z.string(),
  usage: z.object({ prompt_tokens: z.number(), total_tokens: z.number() }),
});

/**
 * Generate a single embedding via OpenRouter.
 */
export async function generateEmbedding(
  text: string,
  apiKey: string,
  model = DEFAULT_MODEL,
): Promise<Float32Array> {
  const res = await fetch(OPENROUTER_BASE, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter embeddings API error ${res.status}: ${body}`);
  }

  const raw: unknown = await res.json();
  const json = EmbeddingResponseSchema.parse(raw);
  if (json.data.length === 0) throw new Error("OpenRouter returned no embeddings");
  return new Float32Array(json.data[0]!.embedding);
}

/**
 * Generate embeddings for multiple texts in batches.
 * Returns a parallel array of Float32Array embeddings.
 */
export async function generateEmbeddings(
  texts: string[],
  apiKey: string,
  model = DEFAULT_MODEL,
): Promise<Float32Array[]> {
  const results: Float32Array[] = Array.from<Float32Array>({ length: texts.length });

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);

    const res = await fetch(OPENROUTER_BASE, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: batch }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter embeddings API error ${res.status}: ${body}`);
    }

    const raw: unknown = await res.json();
    const json = EmbeddingResponseSchema.parse(raw);

    // Sort by index to ensure correct ordering
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    for (let j = 0; j < sorted.length; j++) {
      results[i + j] = new Float32Array(sorted[j]!.embedding);
    }

    // Rate limit: small delay between batches
    if (i + MAX_BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}

/**
 * Validate an API key by making a minimal embedding call.
 * Returns true if the key is valid.
 */
export async function validateApiKey(apiKey: string, model = DEFAULT_MODEL): Promise<boolean> {
  try {
    await generateEmbedding("test", apiKey, model);
    return true;
  } catch {
    return false;
  }
}
