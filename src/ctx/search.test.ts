import { describe, test, expect } from "bun:test";
import { tokenize, filterTokens, buildFtsQuery, buildFtsQueryOr } from "./search.ts";

describe("tokenize", () => {
  test("lowercases and splits on whitespace", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  test("strips non-alphanumeric except hyphens", () => {
    expect(tokenize("fire-and-forget!")).toEqual(["fire-and-forget"]);
  });

  test("returns empty for empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("filterTokens", () => {
  test("removes stopwords", () => {
    expect(filterTokens(["the", "database", "is", "slow"])).toEqual(["database", "slow"]);
  });

  test("removes imperative verbs", () => {
    expect(filterTokens(["fix", "authentication", "bug"])).toEqual(["authentication", "bug"]);
  });

  test("keeps at least one token (longest) when all are stopwords", () => {
    expect(filterTokens(["the", "is", "a"])).toEqual(["the"]);
  });

  test("removes single-char tokens", () => {
    expect(filterTokens(["a", "database", "x"])).toEqual(["database"]);
  });

  test("preserves technical terms", () => {
    expect(filterTokens(["sqlite", "fts5", "search"])).toEqual(["sqlite", "fts5", "search"]);
  });
});

describe("buildFtsQuery", () => {
  test("single token uses prefix match", () => {
    expect(buildFtsQuery(["database"])).toBe('"database"*');
  });

  test("multiple tokens use AND with prefix on last", () => {
    expect(buildFtsQuery(["database", "design"])).toBe('"database" AND "design"*');
  });

  test("three tokens: AND between all, prefix on last", () => {
    expect(buildFtsQuery(["sqlite", "fts5", "search"])).toBe('"sqlite" AND "fts5" AND "search"*');
  });

  test("empty tokens returns empty string", () => {
    expect(buildFtsQuery([])).toBe("");
  });
});

describe("buildFtsQueryOr", () => {
  test("uses OR with prefix on all tokens", () => {
    expect(buildFtsQueryOr(["database", "design"])).toBe('"database"* OR "design"*');
  });
});
