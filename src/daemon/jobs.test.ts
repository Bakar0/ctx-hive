import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readJob,
  writeJob,
  moveJob,
  listJobs,
  failJob,
  ensureJobDirs,
  isGitJobProcessed,
  DONE_DIR,
  FAILED_DIR,
  type SessionMineJob,
  type GitPushJob,
} from "./jobs.ts";

let tempDir: string;
let dirA: string;
let dirB: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ctx-hive-jobs-test-"));
  dirA = join(tempDir, "a");
  dirB = join(tempDir, "b");
  await Bun.write(join(dirA, ".keep"), ""); // mkdir via write
  await Bun.write(join(dirB, ".keep"), "");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("writeJob creates a valid JSON file", async () => {
  const job: SessionMineJob = {
    type: "session-mine",
    sessionId: "test-123",
    transcriptPath: "/tmp/transcript.jsonl",
    cwd: "/tmp/repo",
    createdAt: "2026-03-21T00:00:00.000Z",
  };

  const path = await writeJob(dirA, job, "test-job.json");
  const raw = await readFile(path, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  // oxlint-disable-next-line no-unsafe-type-assertion -- test assertion
  const data = parsed as Record<string, unknown>;

  expect(data.type).toBe("session-mine");
  expect(data.sessionId).toBe("test-123");
  expect(data.cwd).toBe("/tmp/repo");
});

test("readJob parses a job file", async () => {
  const job: SessionMineJob = {
    type: "session-mine",
    sessionId: "abc",
    transcriptPath: "/tmp/t.jsonl",
    cwd: "/tmp",
    createdAt: "2026-03-21T00:00:00.000Z",
  };
  const path = await writeJob(dirA, job, "read-test.json");
  const read = await readJob(path);

  expect(read.type).toBe("session-mine");
  if (read.type !== "session-mine") throw new Error("unexpected type");
  expect(read.sessionId).toBe("abc");
});

test("moveJob moves file between directories", async () => {
  await writeJob(dirA, { type: "session-mine", sessionId: "x", transcriptPath: "", cwd: "", createdAt: "now" }, "move-test.json");
  const srcPath = join(dirA, "move-test.json");

  const destPath = await moveJob(srcPath, dirB);

  expect(destPath).toBe(join(dirB, "move-test.json"));
  const filesA = await readdir(dirA);
  const filesB = await readdir(dirB);
  expect(filesA).not.toContain("move-test.json");
  expect(filesB).toContain("move-test.json");
});

test("listJobs returns sorted .json files", async () => {
  await writeJob(dirA, { type: "session-mine", sessionId: "a", transcriptPath: "", cwd: "", createdAt: "1" }, "002.json");
  await writeJob(dirA, { type: "session-mine", sessionId: "b", transcriptPath: "", cwd: "", createdAt: "2" }, "001.json");
  await writeJob(dirA, { type: "session-mine", sessionId: "c", transcriptPath: "", cwd: "", createdAt: "3" }, "003.json");
  await Bun.write(join(dirA, "not-json.txt"), "ignored");

  const jobs = await listJobs(dirA);

  expect(jobs).toHaveLength(3);
  expect(jobs[0]).toEndWith("001.json");
  expect(jobs[2]).toEndWith("003.json");
});

test("listJobs returns empty array for missing directory", async () => {
  const jobs = await listJobs(join(tempDir, "nonexistent"));
  expect(jobs).toEqual([]);
});

test("isGitJobProcessed returns true when matching headSha+repoPath exists in done", async () => {
  await ensureJobDirs();

  const job: GitPushJob = {
    type: "git-push",
    repoPath: "/Users/test/my-repo",
    headSha: "abc123def456",
    remoteName: "origin",
    remoteUrl: "",
    refs: [],
    createdAt: "2026-03-22T00:00:00.000Z",
  };

  const path = await writeJob(DONE_DIR, job, "dedup-test.json");

  expect(await isGitJobProcessed("abc123def456", "/Users/test/my-repo")).toBe(true);
  expect(await isGitJobProcessed("different-sha", "/Users/test/my-repo")).toBe(false);
  expect(await isGitJobProcessed("abc123def456", "/Users/test/other-repo")).toBe(false);

  // Clean up
  await rm(path);
});

test("failJob appends error info and moves to failed dir", async () => {
  await ensureJobDirs();
  const path = await writeJob(dirA, { type: "session-mine", sessionId: "x", transcriptPath: "", cwd: "", createdAt: "now" }, "fail-test.json");

  const failedPath = await failJob(path, "something went wrong");

  expect(failedPath).toBe(join(FAILED_DIR, "fail-test.json"));
  const raw = await readFile(failedPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  // oxlint-disable-next-line no-unsafe-type-assertion -- test assertion
  const data = parsed as Record<string, unknown>;
  expect(data._error).toBe("something went wrong");
  expect(data._failedAt).toBeTruthy();

  // Clean up from real failed dir
  await rm(failedPath);
});
