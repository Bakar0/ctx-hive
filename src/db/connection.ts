import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureSchema } from "./migrate.ts";

// ── Paths ─────────────────────────────────────────────────────────────

const DB_PATH = join(homedir(), ".ctx-hive", "ctx-hive.db");

// ── Singleton ─────────────────────────────────────────────────────────

let _db: Database | null = null;

/**
 * Returns the singleton Database instance.
 * Creates and initializes the DB on first call (WAL mode, schema migration).
 */
export function getDb(): Database {
  if (_db !== null) return _db;
  mkdirSync(join(homedir(), ".ctx-hive"), { recursive: true });
  _db = openDb(DB_PATH);
  return _db;
}

/**
 * Opens a database at the given path with standard pragmas and schema.
 * Use ":memory:" for tests.
 */
export function openDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  return db;
}

export function closeDb(): void {
  if (_db !== null) {
    _db.close();
    _db = null;
  }
}

/** Replaces the singleton instance. Returns the previous one (if any). */
export function setDb(db: Database | null): Database | null {
  const prev = _db;
  _db = db;
  return prev;
}
