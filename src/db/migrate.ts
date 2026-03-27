import type { Database } from "bun:sqlite";
import { isSqliteVecAvailable } from "./connection.ts";

// ── Public API ────────────────────────────────────────────────────────

export function ensureSchema(db: Database): void {
  const hasMeta = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get();

  const row = hasMeta
    ? db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='version'").get()
    : null;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  if (currentVersion < 1) {
    migrateToV1(db);
  }
  if (currentVersion < 2) {
    migrateToV2(db);
  }
  if (currentVersion < 3) {
    migrateToV3(db);
  }
}

// ── V1 Schema ─────────────────────────────────────────────────────────

function migrateToV1(db: Database): void {
  const migrate = db.transaction(() => {
    // ── Schema version tracking ──────────────────────────────────
    db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    // ── Entries ──────────────────────────────────────────────────
    db.exec(`CREATE TABLE entries (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      slug       TEXT NOT NULL,
      scope      TEXT NOT NULL CHECK(scope IN ('project', 'org', 'personal')),
      tags       TEXT NOT NULL DEFAULT '[]',
      project    TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL DEFAULT '',
      tokens     INTEGER NOT NULL DEFAULT 0,
      embedding  BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX idx_entries_scope ON entries(scope)");
    db.exec("CREATE INDEX idx_entries_project ON entries(project)");
    db.exec("CREATE UNIQUE INDEX idx_entries_scope_slug ON entries(scope, slug)");

    // ── FTS5 full-text search ────────────────────────────────────
    db.exec(`CREATE VIRTUAL TABLE entries_fts USING fts5(
      title, tags, body,
      content='entries',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )`);

    // Triggers to keep FTS in sync with entries table
    db.exec(`CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(rowid, title, tags, body)
      VALUES (new.rowid, new.title, new.tags, new.body);
    END`);

    db.exec(`CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, tags, body)
      VALUES ('delete', old.rowid, old.title, old.tags, old.body);
    END`);

    db.exec(`CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, title, tags, body)
      VALUES ('delete', old.rowid, old.title, old.tags, old.body);
      INSERT INTO entries_fts(rowid, title, tags, body)
      VALUES (new.rowid, new.title, new.tags, new.body);
    END`);

    // ── Jobs ─────────────────────────────────────────────────────
    db.exec(`CREATE TABLE jobs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      filename          TEXT NOT NULL UNIQUE,
      type              TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'processing', 'done', 'failed')),
      payload           TEXT NOT NULL,
      error             TEXT,
      created_at        TEXT NOT NULL,
      started_at        TEXT,
      completed_at      TEXT,
      failed_at         TEXT,
      duration_ms       INTEGER,
      transcript_tokens INTEGER,
      entries_created   INTEGER,
      input_tokens      INTEGER,
      output_tokens     INTEGER,
      pipeline_data     TEXT
    )`);
    db.exec("CREATE INDEX idx_jobs_status ON jobs(status)");
    db.exec("CREATE INDEX idx_jobs_type ON jobs(type)");
    db.exec("CREATE INDEX idx_jobs_created ON jobs(created_at)");

    // ── Pipeline executions ──────────────────────────────────────
    db.exec(`CREATE TABLE pipeline_executions (
      id                  TEXT PRIMARY KEY,
      pipeline_name       TEXT NOT NULL,
      status              TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      job_filename        TEXT NOT NULL,
      project             TEXT NOT NULL,
      started_at          TEXT NOT NULL,
      completed_at        TEXT,
      total_duration_ms   INTEGER,
      total_input_tokens  INTEGER,
      total_output_tokens INTEGER,
      total_cost_usd      REAL,
      entries_created     INTEGER
    )`);
    db.exec("CREATE INDEX idx_executions_project ON pipeline_executions(project)");
    db.exec("CREATE INDEX idx_executions_status ON pipeline_executions(status)");
    db.exec("CREATE INDEX idx_executions_started ON pipeline_executions(started_at)");

    db.exec(`CREATE TABLE pipeline_stages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL REFERENCES pipeline_executions(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      status       TEXT NOT NULL,
      started_at   TEXT,
      completed_at TEXT,
      duration_ms  INTEGER,
      retry_count  INTEGER NOT NULL DEFAULT 0,
      error        TEXT,
      metrics      TEXT NOT NULL DEFAULT '{}'
    )`);
    db.exec("CREATE INDEX idx_stages_execution ON pipeline_stages(execution_id)");

    db.exec(`CREATE TABLE pipeline_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL REFERENCES pipeline_executions(id) ON DELETE CASCADE,
      stage_name   TEXT NOT NULL,
      timestamp    TEXT NOT NULL,
      data         TEXT NOT NULL,
      metrics      TEXT,
      UNIQUE(execution_id, stage_name)
    )`);

    // ── Search history ───────────────────────────────────────────
    db.exec(`CREATE TABLE search_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp    TEXT NOT NULL,
      source       TEXT NOT NULL CHECK(source IN ('inject', 'cli', 'api')),
      query        TEXT NOT NULL,
      project      TEXT,
      cwd          TEXT,
      session_id   TEXT,
      result_count INTEGER NOT NULL,
      duration_ms  INTEGER NOT NULL
    )`);
    db.exec("CREATE INDEX idx_search_history_session ON search_history(session_id)");
    db.exec("CREATE INDEX idx_search_history_source ON search_history(source)");
    db.exec("CREATE INDEX idx_search_history_timestamp ON search_history(timestamp)");

    db.exec(`CREATE TABLE search_results (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      history_id INTEGER NOT NULL REFERENCES search_history(id) ON DELETE CASCADE,
      entry_id   TEXT NOT NULL,
      title      TEXT NOT NULL,
      score      REAL NOT NULL,
      tokens     INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec("CREATE INDEX idx_search_results_history ON search_results(history_id)");
    db.exec("CREATE INDEX idx_search_results_entry ON search_results(entry_id)");

    // ── Signals ──────────────────────────────────────────────────
    db.exec(`CREATE TABLE signal_hits (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL,
      date     TEXT NOT NULL,
      count    INTEGER NOT NULL DEFAULT 1,
      UNIQUE(entry_id, date)
    )`);
    db.exec("CREATE INDEX idx_signal_hits_entry ON signal_hits(entry_id)");

    db.exec(`CREATE TABLE signal_evaluations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id     TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      rating       INTEGER NOT NULL CHECK(rating IN (-1, 0, 1, 2)),
      reason       TEXT,
      evaluated_at TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX idx_signal_evals_entry ON signal_evaluations(entry_id)");
    db.exec("CREATE INDEX idx_signal_evals_session ON signal_evaluations(session_id)");

    // ── Tracked repos ────────────────────────────────────────────
    db.exec(`CREATE TABLE tracked_repos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      abs_path        TEXT NOT NULL UNIQUE,
      org             TEXT NOT NULL DEFAULT '',
      remote_url      TEXT NOT NULL DEFAULT '',
      tracked_at      TEXT NOT NULL,
      last_scanned_at TEXT
    )`);

    // ── Set version ──────────────────────────────────────────────
    db.exec("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '1')");
  });

  migrate();
}

// ── V2 Schema: Rename filename → job_id ──────────────────────────────


function migrateToV2(db: Database): void {
  const migrate = db.transaction(() => {
    db.exec("ALTER TABLE jobs RENAME COLUMN filename TO job_id");
    db.exec("ALTER TABLE pipeline_executions RENAME COLUMN job_filename TO job_id");
    db.exec("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '2')");
  });

  migrate();
}

// ── V3 Schema: Settings, vector search, per-algorithm metrics ─────────

function migrateToV3(db: Database): void {
  const migrate = db.transaction(() => {
    // ── Settings key-value store ─────────────────────────────────
    db.exec(`CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    // ── Per-algorithm timing on search history ───────────────────
    db.exec("ALTER TABLE search_history ADD COLUMN fts_duration_ms INTEGER");
    db.exec("ALTER TABLE search_history ADD COLUMN vector_duration_ms INTEGER");

    // ── Algorithm provenance on search results ───────────────────
    db.exec("ALTER TABLE search_results ADD COLUMN algorithm TEXT NOT NULL DEFAULT 'fts5'");

    db.exec("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '3')");
  });

  migrate();

  // ── vec0 virtual table (outside transaction — vtable DDL can't be transactional)
  // Only create if sqlite-vec extension is loaded (not available in compiled binaries)
  if (isSqliteVecAvailable()) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
      entry_id TEXT PRIMARY KEY,
      embedding float[1536]
    )`);
  }
}
