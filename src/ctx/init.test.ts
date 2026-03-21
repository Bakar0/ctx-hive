import { test, expect, afterAll } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanForRepos,
  resolveRepoMeta,
  gatherRepoContext,
  buildRepoPrompt,
  buildSessionPrompt,
} from "./init.ts";

const TEST_DIR = join(tmpdir(), `omni-init-test-${Date.now()}`);

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ── scanForRepos ──────────────────────────────────────────────────────

test("scanForRepos finds repos with .git directories", async () => {
  const root = join(TEST_DIR, "scan-test");
  await mkdir(join(root, "repo-a", ".git"), { recursive: true });
  await mkdir(join(root, "repo-b", ".git"), { recursive: true });
  await mkdir(join(root, "not-a-repo"), { recursive: true });

  const repos = await scanForRepos(root);
  const names = repos.map((r) => r.name).sort();
  expect(names).toContain("repo-a");
  expect(names).toContain("repo-b");
  expect(names).not.toContain("not-a-repo");
});

test("scanForRepos skips node_modules", async () => {
  const root = join(TEST_DIR, "skip-nm-test");
  await mkdir(join(root, "node_modules", "some-dep", ".git"), { recursive: true });
  await mkdir(join(root, "real-repo", ".git"), { recursive: true });

  const repos = await scanForRepos(root);
  expect(repos.length).toBe(1);
  expect(repos[0]!.name).toBe("real-repo");
});

test("scanForRepos respects maxDepth", async () => {
  const root = join(TEST_DIR, "depth-test");
  await mkdir(join(root, "a", "b", "c", "d", "e", "deep-repo", ".git"), { recursive: true });
  await mkdir(join(root, "shallow-repo", ".git"), { recursive: true });

  const repos = await scanForRepos(root, 2);
  const names = repos.map((r) => r.name);
  expect(names).toContain("shallow-repo");
  expect(names).not.toContain("deep-repo");
});

test("scanForRepos sets correct relPath", async () => {
  const root = join(TEST_DIR, "relpath-test");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "sub", "nested-repo", ".git"), { recursive: true });

  const repos = await scanForRepos(root);
  const rootRepo = repos.find((r) => r.relPath === ".");
  const nested = repos.find((r) => r.name === "nested-repo");

  expect(rootRepo).toBeDefined();
  expect(nested).toBeDefined();
  expect(nested!.relPath).toBe(join("sub", "nested-repo"));
});

test("scanForRepos returns empty for dir with no repos", async () => {
  const root = join(TEST_DIR, "empty-test");
  await mkdir(root, { recursive: true });

  const repos = await scanForRepos(root);
  expect(repos).toEqual([]);
});

// ── resolveRepoMeta ──────────────────────────────────────────────────

test("resolveRepoMeta returns fallback for non-git dir", async () => {
  const dir = join(TEST_DIR, "no-git-meta");
  await mkdir(dir, { recursive: true });

  const meta = await resolveRepoMeta(dir);
  expect(meta.name).toBe("no-git-meta");
  expect(meta.org).toBe("");
});

// ── gatherRepoContext ─────────────────────────────────────────────────

test("gatherRepoContext reads README.md and CLAUDE.md", async () => {
  const dir = join(TEST_DIR, "context-test");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "README.md"), "# My Project\nA test project.");
  await Bun.write(join(dir, "CLAUDE.md"), "Use bun not node.");

  const ctx = await gatherRepoContext(dir);
  expect(ctx.readme).toContain("My Project");
  expect(ctx.claudeMd).toContain("bun not node");
});

test("gatherRepoContext returns empty strings when files missing", async () => {
  const dir = join(TEST_DIR, "no-readme-test");
  await mkdir(dir, { recursive: true });

  const ctx = await gatherRepoContext(dir);
  expect(ctx.readme).toBe("");
  expect(ctx.claudeMd).toBe("");
});

test("gatherRepoContext truncates large files", async () => {
  const dir = join(TEST_DIR, "large-readme-test");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "README.md"), "x".repeat(10000));

  const ctx = await gatherRepoContext(dir);
  expect(ctx.readme.length).toBe(5000);
});

// ── buildRepoPrompt ──────────────────────────────────────────────────

test("buildRepoPrompt includes repo metadata", () => {
  const prompt = buildRepoPrompt(
    { name: "my-app", org: "acme", remoteUrl: "git@github.com:acme/my-app.git" },
    { readme: "# My App", claudeMd: "" },
    [],
    false,
  );

  expect(prompt).toContain("my-app");
  expect(prompt).toContain("acme");
  expect(prompt).toContain("git@github.com:acme/my-app.git");
  expect(prompt).toContain("# My App");
  expect(prompt).toContain("Repo Analyzer");
});

test("buildRepoPrompt includes existing entries in update mode", () => {
  const existing = [
    {
      id: "abc12345",
      title: "Auth patterns",
      scope: "project" as const,
      tags: ["auth"],
      project: "my-app",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      path: "entries/project/auth-patterns.md",
    },
  ];

  const prompt = buildRepoPrompt(
    { name: "my-app", org: "acme", remoteUrl: "" },
    { readme: "", claudeMd: "" },
    existing,
    true,
  );

  expect(prompt).toContain("Existing Context Entries (1)");
  expect(prompt).toContain("Auth patterns");
  expect(prompt).toContain("UPDATE run");
  expect(prompt).toContain("ctx-hive delete");
});

test("buildRepoPrompt includes project name in add instructions", () => {
  const prompt = buildRepoPrompt(
    { name: "backend-api", org: "acme", remoteUrl: "" },
    { readme: "", claudeMd: "" },
    [],
    false,
  );

  expect(prompt).toContain('--project "backend-api"');
});

// ── buildSessionPrompt ───────────────────────────────────────────────

test("buildSessionPrompt includes session file paths", () => {
  const paths = ["/home/user/.claude/projects/foo/session-1.jsonl", "/home/user/.claude/projects/foo/session-2.jsonl"];

  const prompt = buildSessionPrompt(
    { name: "my-app", org: "", remoteUrl: "" },
    paths,
    [],
    false,
  );

  expect(prompt).toContain("Session Miner");
  expect(prompt).toContain("session-1.jsonl");
  expect(prompt).toContain("session-2.jsonl");
  expect(prompt).toContain("JSONL format");
});

test("buildSessionPrompt includes instructions for reading sessions", () => {
  const prompt = buildSessionPrompt(
    { name: "my-app", org: "", remoteUrl: "" },
    ["/tmp/session.jsonl"],
    [],
    false,
  );

  expect(prompt).toContain("Decisions made");
  expect(prompt).toContain("Recurring themes");
  expect(prompt).toContain("Developer preferences");
  expect(prompt).toContain("first ~200 lines");
});

test("buildSessionPrompt includes existing entries in update mode", () => {
  const existing = [
    {
      id: "abc12345",
      title: "Auth patterns",
      scope: "project" as const,
      tags: ["auth"],
      project: "my-app",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      path: "entries/project/auth-patterns.md",
    },
  ];

  const prompt = buildSessionPrompt(
    { name: "my-app", org: "", remoteUrl: "" },
    ["/tmp/session.jsonl"],
    existing,
    true,
  );

  expect(prompt).toContain("Existing Context Entries (1)");
  expect(prompt).toContain("UPDATE run");
});
