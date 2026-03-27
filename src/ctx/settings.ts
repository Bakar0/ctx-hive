import { getDb } from "../db/connection.ts";

// ── Generic settings CRUD ─────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare<{ value: string }, [string]>(
    "SELECT value FROM settings WHERE key = ?",
  ).get(key);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function deleteSetting(key: string): void {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// ── Vector search convenience helpers ─────────────────────────────────

export function isVectorSearchEnabled(): boolean {
  return getSetting("vector_search.enabled") === "true";
}

export function getOpenRouterApiKey(): string | null {
  return getSetting("vector_search.api_key");
}

export function getVectorSearchConfig(): {
  enabled: boolean;
  apiKey: string | null;
  model: string;
} {
  return {
    enabled: isVectorSearchEnabled(),
    apiKey: getOpenRouterApiKey(),
    model: getSetting("vector_search.model") ?? "openai/text-embedding-3-small",
  };
}
