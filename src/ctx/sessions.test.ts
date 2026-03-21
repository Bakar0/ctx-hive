import { test, expect, afterAll } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  encodeSessionPath,
  repoToSessionDir,
  listSessionFiles,
  getSessionFilePaths,
} from "./sessions.ts";

const TEST_DIR = join(tmpdir(), `omni-sessions-test-${Date.now()}`);

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ── encodeSessionPath ──────────────────────────────────────────────────

test("encodeSessionPath replaces slashes with dashes", () => {
  expect(encodeSessionPath("/Users/foo/myrepo")).toBe("-Users-foo-myrepo");
});

test("encodeSessionPath handles current directory", () => {
  const encoded = encodeSessionPath(".");
  expect(encoded).not.toContain("/");
  expect(encoded.startsWith("-")).toBe(true);
});

// ── repoToSessionDir ──────────────────────────────────────────────────

test("repoToSessionDir returns correct path under ~/.claude/projects/", () => {
  const dir = repoToSessionDir("/Users/foo/myrepo");
  expect(dir).toContain(".claude/projects/-Users-foo-myrepo");
});

// ── listSessionFiles ──────────────────────────────────────────────────

test("listSessionFiles returns empty for nonexistent dir", async () => {
  const files = await listSessionFiles("/nonexistent/path");
  expect(files).toEqual([]);
});

test("listSessionFiles returns .jsonl files sorted by mtime", async () => {
  const dir = join(TEST_DIR, "list-test");
  await mkdir(dir, { recursive: true });

  await Bun.write(join(dir, "old.jsonl"), "{}");
  await new Promise((r) => setTimeout(r, 50));
  await Bun.write(join(dir, "new.jsonl"), "{}");
  await Bun.write(join(dir, "readme.txt"), "hello");

  const files = await listSessionFiles(dir);
  expect(files.length).toBe(2);
  expect(files[0]!.path).toContain("new.jsonl");
  expect(files[1]!.path).toContain("old.jsonl");
});

// ── getSessionFilePaths ───────────────────────────────────────────────

test("getSessionFilePaths returns top N paths for a repo", async () => {
  // Create a fake session dir matching the encoding
  const fakeRepo = join(TEST_DIR, "fake-repo");
  await mkdir(fakeRepo, { recursive: true });

  const encoded = fakeRepo.replace(/\//g, "-");
  const sessionDir = join(homedir(), ".claude", "projects", encoded);
  await mkdir(sessionDir, { recursive: true });

  for (let i = 0; i < 5; i++) {
    await Bun.write(join(sessionDir, `session-${i}.jsonl`), "{}");
    await new Promise((r) => setTimeout(r, 20));
  }

  const paths = await getSessionFilePaths(fakeRepo, 3);
  expect(paths.length).toBe(3);
  // Should be sorted newest first
  expect(paths[0]!).toContain("session-4.jsonl");

  // Cleanup
  await rm(sessionDir, { recursive: true, force: true });
});

test("getSessionFilePaths returns empty for repo with no sessions", async () => {
  const paths = await getSessionFilePaths("/nonexistent/repo/path", 10);
  expect(paths).toEqual([]);
});
