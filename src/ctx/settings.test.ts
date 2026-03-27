import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openDb, setDb } from "../db/connection.ts";
import type { Database } from "bun:sqlite";
import {
  getSetting,
  setSetting,
  deleteSetting,
  isVectorSearchEnabled,
  getOpenRouterApiKey,
  getVectorSearchConfig,
} from "./settings.ts";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  setDb(db);
});

afterEach(() => {
  db.close();
  setDb(null);
});

describe("settings CRUD", () => {
  test("getSetting returns null for missing key", () => {
    expect(getSetting("nonexistent")).toBeNull();
  });

  test("setSetting and getSetting round-trip", () => {
    setSetting("test.key", "hello");
    expect(getSetting("test.key")).toBe("hello");
  });

  test("setSetting upserts on conflict", () => {
    setSetting("test.key", "v1");
    setSetting("test.key", "v2");
    expect(getSetting("test.key")).toBe("v2");
  });

  test("deleteSetting removes the key", () => {
    setSetting("test.key", "value");
    deleteSetting("test.key");
    expect(getSetting("test.key")).toBeNull();
  });

  test("deleteSetting is a no-op for missing key", () => {
    expect(() => deleteSetting("nonexistent")).not.toThrow();
  });
});

describe("vector search helpers", () => {
  test("isVectorSearchEnabled defaults to false", () => {
    expect(isVectorSearchEnabled()).toBe(false);
  });

  test("isVectorSearchEnabled returns true when set", () => {
    setSetting("vector_search.enabled", "true");
    expect(isVectorSearchEnabled()).toBe(true);
  });

  test("isVectorSearchEnabled returns false for non-true value", () => {
    setSetting("vector_search.enabled", "false");
    expect(isVectorSearchEnabled()).toBe(false);
  });

  test("getOpenRouterApiKey returns null when not set", () => {
    expect(getOpenRouterApiKey()).toBeNull();
  });

  test("getOpenRouterApiKey returns stored key", () => {
    setSetting("vector_search.api_key", "sk-or-test-key");
    expect(getOpenRouterApiKey()).toBe("sk-or-test-key");
  });

  test("getVectorSearchConfig returns defaults", () => {
    const config = getVectorSearchConfig();
    expect(config.enabled).toBe(false);
    expect(config.apiKey).toBeNull();
    expect(config.model).toBe("openai/text-embedding-3-small");
  });

  test("getVectorSearchConfig returns stored values", () => {
    setSetting("vector_search.enabled", "true");
    setSetting("vector_search.api_key", "sk-or-key");
    setSetting("vector_search.model", "openai/text-embedding-3-large");
    const config = getVectorSearchConfig();
    expect(config.enabled).toBe(true);
    expect(config.apiKey).toBe("sk-or-key");
    expect(config.model).toBe("openai/text-embedding-3-large");
  });
});
