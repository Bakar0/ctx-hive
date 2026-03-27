import { describe, test, expect } from "bun:test";
import { EMBEDDING_DIMS } from "./embeddings.ts";

describe("embeddings", () => {
  test("EMBEDDING_DIMS is 1536 for text-embedding-3-small", () => {
    expect(EMBEDDING_DIMS).toBe(1536);
  });
});
