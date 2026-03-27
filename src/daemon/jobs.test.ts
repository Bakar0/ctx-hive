import { test, expect, beforeEach, afterEach } from "bun:test";
import { openDb, setDb } from "../db/connection.ts";
import {
  readJob,
  writeJob,
  listJobs,
  failJob,
  completeJob,
  stampStarted,
  isDuplicate,
  isGitJobProcessed,
  type SessionMineJob,
  type GitPushJob,
} from "./jobs.ts";


let cleanup: (() => void) | null = null;

beforeEach(() => {
  const db = openDb(":memory:");
  cleanup = () => {
    const prev = setDb(null);
    prev?.close();
  };
  setDb(db);
});

afterEach(() => {
  cleanup?.();
});

test("writeJob and readJob round-trip", () => {
  const job: SessionMineJob = {
    type: "session-mine",
    sessionId: "test-123",
    transcriptPath: "/tmp/transcript.jsonl",
    cwd: "/tmp/repo",
    createdAt: "2026-03-21T00:00:00.000Z",
  };

  writeJob(job, "test-job");
  const read = readJob("test-job");

  expect(read.type).toBe("session-mine");
  if (read.type !== "session-mine") throw new Error("unexpected type");
  expect(read.sessionId).toBe("test-123");
  expect(read.cwd).toBe("/tmp/repo");
});

test("listJobs returns job IDs for a status", () => {
  writeJob({ type: "session-mine", sessionId: "a", transcriptPath: "", cwd: "", createdAt: "1" }, "002");
  writeJob({ type: "session-mine", sessionId: "b", transcriptPath: "", cwd: "", createdAt: "2" }, "001");
  writeJob({ type: "session-mine", sessionId: "c", transcriptPath: "", cwd: "", createdAt: "3" }, "003");

  const jobs = listJobs("pending");

  expect(jobs).toHaveLength(3);
  expect(jobs[0]).toBe("002");
  expect(jobs[2]).toBe("003");
});

test("listJobs returns empty array for unknown status", () => {
  const jobs = listJobs("done");
  expect(jobs).toEqual([]);
});

test("stampStarted updates status to processing", () => {
  writeJob({ type: "session-mine", sessionId: "x", transcriptPath: "", cwd: "", createdAt: "now" }, "stamp-test");

  stampStarted("stamp-test");

  const processing = listJobs("processing");
  expect(processing).toContain("stamp-test");

  const pending = listJobs("pending");
  expect(pending).not.toContain("stamp-test");
});

test("completeJob marks job as done", () => {
  writeJob({ type: "session-mine", sessionId: "x", transcriptPath: "", cwd: "", createdAt: "now" }, "complete-test");
  stampStarted("complete-test");

  completeJob("complete-test", { success: true, durationMs: 1000, entriesCreated: 3 });

  const done = listJobs("done");
  expect(done).toContain("complete-test");
});

test("failJob marks job as failed with error", () => {
  writeJob({ type: "session-mine", sessionId: "x", transcriptPath: "", cwd: "", createdAt: "now" }, "fail-test");

  failJob("fail-test", "something went wrong");

  const failed = listJobs("failed");
  expect(failed).toContain("fail-test");

  const pending = listJobs("pending");
  expect(pending).not.toContain("fail-test");
});

test("isDuplicate detects completed session-mine jobs", () => {
  writeJob({
    type: "session-mine", sessionId: "dup-123", transcriptPath: "", cwd: "", createdAt: "now",
  }, "dup-test");
  completeJob("dup-test", { success: true, durationMs: 100 });

  expect(isDuplicate("dup-123")).toBe(true);
  expect(isDuplicate("other-id")).toBe(false);
});

test("isGitJobProcessed returns true when matching headSha+repoPath exists in done", () => {
  const job: GitPushJob = {
    type: "git-push",
    repoPath: "/Users/test/my-repo",
    headSha: "abc123def456",
    remoteName: "origin",
    remoteUrl: "",
    refs: [],
    createdAt: "2026-03-22T00:00:00.000Z",
  };

  writeJob(job, "dedup-test");
  completeJob("dedup-test", { success: true, durationMs: 100 });

  expect(isGitJobProcessed("abc123def456", "/Users/test/my-repo")).toBe(true);
  expect(isGitJobProcessed("different-sha", "/Users/test/my-repo")).toBe(false);
  expect(isGitJobProcessed("abc123def456", "/Users/test/other-repo")).toBe(false);
});
