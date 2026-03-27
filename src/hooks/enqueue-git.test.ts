import { test, expect, beforeEach, afterEach } from "bun:test";
import { openDb, setDb } from "../db/connection.ts";
import {
  writeJob,
  readJob,
  type GitPushJob,
  type GitPullJob,
} from "../daemon/jobs.ts";

beforeEach(() => {
  const db = openDb(":memory:");
  setDb(db);
});

afterEach(() => {
  const prev = setDb(null);
  prev?.close();
});

test("GitPushJob can be written and read back with headSha", () => {
  const job: GitPushJob = {
    type: "git-push",
    repoPath: "/Users/test/my-repo",
    headSha: "abc123def456",
    remoteName: "origin",
    remoteUrl: "git@github.com:org/my-repo.git",
    refs: [
      {
        localRef: "refs/heads/main",
        localSha: "abc123",
        remoteRef: "refs/heads/main",
        remoteSha: "def456",
      },
    ],
    createdAt: "2026-03-22T00:00:00.000Z",
  };

  writeJob(job, "push-test");
  const read = readJob("push-test");
  expect(read.type).toBe("git-push");
  if (read.type !== "git-push") throw new Error("unexpected type");
  expect(read.headSha).toBe("abc123def456");
  expect(read.repoPath).toBe("/Users/test/my-repo");
  expect(read.remoteName).toBe("origin");
  expect(read.remoteUrl).toBe("git@github.com:org/my-repo.git");
  expect(read.refs).toHaveLength(1);
  expect(read.refs[0]!.localSha).toBe("abc123");
});

test("GitPullJob merge can be written and read back with headSha", () => {
  const job: GitPullJob = {
    type: "git-pull",
    repoPath: "/Users/test/my-repo",
    headSha: "fff999",
    trigger: "merge",
    squash: false,
    createdAt: "2026-03-22T00:00:00.000Z",
  };

  writeJob(job, "pull-merge-test");
  const read = readJob("pull-merge-test");
  expect(read.type).toBe("git-pull");
  if (read.type !== "git-pull") throw new Error("unexpected type");
  expect(read.headSha).toBe("fff999");
  expect(read.trigger).toBe("merge");
  expect(read.squash).toBe(false);
  expect(read.rewrittenShas).toBeUndefined();
});

test("GitPullJob rebase includes rewritten SHAs", () => {
  const job: GitPullJob = {
    type: "git-pull",
    repoPath: "/Users/test/my-repo",
    headSha: "eee888",
    trigger: "rebase",
    rewrittenShas: [
      { oldSha: "aaa111", newSha: "bbb222" },
      { oldSha: "ccc333", newSha: "ddd444" },
    ],
    createdAt: "2026-03-22T00:00:00.000Z",
  };

  writeJob(job, "pull-rebase-test");
  const read = readJob("pull-rebase-test");
  expect(read.type).toBe("git-pull");
  if (read.type !== "git-pull") throw new Error("unexpected type");
  expect(read.headSha).toBe("eee888");
  expect(read.trigger).toBe("rebase");
  expect(read.rewrittenShas).toHaveLength(2);
  expect(read.rewrittenShas![0]!.oldSha).toBe("aaa111");
  expect(read.rewrittenShas![1]!.newSha).toBe("ddd444");
});

test("GitPushJob with multiple refs", () => {
  const job: GitPushJob = {
    type: "git-push",
    repoPath: "/Users/test/my-repo",
    headSha: "head111",
    remoteName: "origin",
    remoteUrl: "https://github.com/org/repo.git",
    refs: [
      { localRef: "refs/heads/main", localSha: "aaa", remoteRef: "refs/heads/main", remoteSha: "bbb" },
      { localRef: "refs/heads/feature", localSha: "ccc", remoteRef: "refs/heads/feature", remoteSha: "ddd" },
    ],
    createdAt: "2026-03-22T00:00:00.000Z",
  };

  writeJob(job, "multi-ref-push");
  const read = readJob("multi-ref-push");
  if (read.type !== "git-push") throw new Error("unexpected type");
  expect(read.refs).toHaveLength(2);
  expect(read.refs[1]!.localRef).toBe("refs/heads/feature");
});

test("GitPushJob with empty refs (no stdin)", () => {
  const job: GitPushJob = {
    type: "git-push",
    repoPath: "/Users/test/my-repo",
    headSha: "head222",
    remoteName: "origin",
    remoteUrl: "",
    refs: [],
    createdAt: "2026-03-22T00:00:00.000Z",
  };

  writeJob(job, "empty-refs");
  const read = readJob("empty-refs");
  if (read.type !== "git-push") throw new Error("unexpected type");
  expect(read.refs).toHaveLength(0);
  expect(read.headSha).toBe("head222");
});
