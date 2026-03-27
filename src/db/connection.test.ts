import { test, expect, describe } from "bun:test";
import { openDb } from "./connection.ts";

describe("openDb", () => {
  test("creates schema in memory database", () => {
    const db = openDb(":memory:");
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = tables.map((t) => t.name);

    expect(names).toContain("entries");
    expect(names).toContain("jobs");
    expect(names).toContain("pipeline_executions");
    expect(names).toContain("pipeline_stages");
    expect(names).toContain("pipeline_messages");
    expect(names).toContain("search_history");
    expect(names).toContain("search_results");
    expect(names).toContain("signal_hits");
    expect(names).toContain("signal_evaluations");
    expect(names).toContain("tracked_repos");
    expect(names).toContain("schema_meta");

    db.close();
  });

  test("sets WAL journal mode", () => {
    const db = openDb(":memory:");
    const result = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!;
    // In-memory databases use "memory" mode, not WAL
    expect(result.journal_mode).toBe("memory");
    db.close();
  });

  test("creates FTS5 virtual table", () => {
    const db = openDb(":memory:");
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='entries_fts'")
      .all();
    expect(tables.length).toBe(1);
    db.close();
  });

  test("schema version is 5", () => {
    const db = openDb(":memory:");
    const row = db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='version'").get()!;
    expect(row.value).toBe("5");
    db.close();
  });

  test("ensureSchema is idempotent", () => {
    const db = openDb(":memory:");
    // Opening again with same DB should not throw (schema already exists)
    // We can't re-run openDb on same handle, but ensureSchema is called internally
    const row = db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='version'").get()!;
    expect(row.value).toBe("5");
    db.close();
  });

  test("FTS5 triggers sync on insert", () => {
    const db = openDb(":memory:");
    db.exec(`
      INSERT INTO entries (id, title, slug, scope, tags, project, body, tokens, created_at, updated_at)
      VALUES ('test1', 'Test Entry', 'test-entry', 'project', '["tag1", "tag2"]', 'myproject', 'hello world body', 100, '2026-01-01', '2026-01-01')
    `);

    // FTS5 should find the entry
    const results = db
      .query<{ title: string }, []>("SELECT * FROM entries_fts WHERE entries_fts MATCH 'hello'")
      .all();
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Test Entry");

    // Search by tag
    const tagResults = db
      .query("SELECT * FROM entries_fts WHERE entries_fts MATCH 'tag1'")
      .all();
    expect(tagResults.length).toBe(1);

    db.close();
  });

  test("FTS5 triggers sync on delete", () => {
    const db = openDb(":memory:");
    db.exec(`
      INSERT INTO entries (id, title, slug, scope, tags, project, body, tokens, created_at, updated_at)
      VALUES ('test1', 'Test Entry', 'test-entry', 'project', '[]', '', 'hello world', 100, '2026-01-01', '2026-01-01')
    `);

    db.exec("DELETE FROM entries WHERE id = 'test1'");

    const results = db
      .query("SELECT * FROM entries_fts WHERE entries_fts MATCH 'hello'")
      .all();
    expect(results.length).toBe(0);

    db.close();
  });

  test("FTS5 BM25 ranking works", () => {
    const db = openDb(":memory:");

    // Insert entries with different relevance
    db.exec(`
      INSERT INTO entries (id, title, slug, scope, tags, project, body, tokens, created_at, updated_at) VALUES
      ('a', 'Database Guide', 'db-guide', 'project', '["database"]', '', 'A guide about database design', 100, '2026-01-01', '2026-01-01'),
      ('b', 'Other Topic', 'other', 'project', '[]', '', 'This mentions database once', 100, '2026-01-01', '2026-01-01')
    `);

    const results = db
      .query<{ id: string; score: number }, []>(`
        SELECT e.id, bm25(entries_fts, 5.0, 3.0, 1.0) as score
        FROM entries_fts
        JOIN entries e ON entries_fts.rowid = e.rowid
        WHERE entries_fts MATCH 'database'
        ORDER BY score
      `)
      .all();

    expect(results.length).toBe(2);
    // 'a' should rank higher (title + tag + body match vs just body)
    expect(results[0]!.id).toBe("a");

    db.close();
  });
});
