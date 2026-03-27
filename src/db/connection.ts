import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureSchema } from "./migrate.ts";

// ── sqlite-vec requires a SQLite build with extension loading ─────────
// Bun's built-in SQLite doesn't support loadExtension, so we use the
// system/Homebrew SQLite when available.
const CUSTOM_SQLITE_PATHS = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // macOS ARM Homebrew
  "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",   // macOS x64 Homebrew
];

for (const p of CUSTOM_SQLITE_PATHS) {
  if (existsSync(p)) {
    Database.setCustomSQLite(p);
    break;
  }
}

// Track whether sqlite-vec is available for this process
let _sqliteVecAvailable = false;

/** Returns true if sqlite-vec extension loaded successfully. */
export function isSqliteVecAvailable(): boolean {
  return _sqliteVecAvailable;
}

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

  // Try to load sqlite-vec — graceful fallback if unavailable (e.g. compiled binary)
  try {
    const mod: unknown = require("sqlite-vec");
    if (mod !== null && typeof mod === "object" && "load" in mod) {
      const loadFn = mod.load;
      if (typeof loadFn === "function") {
        Reflect.apply(loadFn, mod, [db]);
        _sqliteVecAvailable = true;
      }
    }
  } catch {
    _sqliteVecAvailable = false;
  }

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
