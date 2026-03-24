import { test, expect, describe } from "bun:test";
import { findTrackedRepoFor, type TrackedRepo } from "./tracking.ts";

const makeRepo = (absPath: string): TrackedRepo => ({
  name: absPath.split("/").pop() ?? "test",
  absPath,
  org: "test-org",
  remoteUrl: "",
  trackedAt: new Date().toISOString(),
});

describe("findTrackedRepoFor", () => {
  test("exact match", () => {
    const repos = [makeRepo("/Users/dev/my-repo")];
    const result = findTrackedRepoFor("/Users/dev/my-repo", repos);
    expect(result?.absPath).toBe("/Users/dev/my-repo");
  });

  test("subdirectory match", () => {
    const repos = [makeRepo("/Users/dev/my-repo")];
    const result = findTrackedRepoFor("/Users/dev/my-repo/src/components", repos);
    expect(result?.absPath).toBe("/Users/dev/my-repo");
  });

  test("returns undefined for unrelated path", () => {
    const repos = [makeRepo("/Users/dev/my-repo")];
    expect(findTrackedRepoFor("/Users/dev/other-repo", repos)).toBeUndefined();
  });

  test("does not match path prefix without separator", () => {
    const repos = [makeRepo("/Users/dev/ctx-hive")];
    expect(findTrackedRepoFor("/Users/dev/ctx-hive-other", repos)).toBeUndefined();
  });

  test("picks deepest ancestor for nested repos", () => {
    const repos = [
      makeRepo("/Users/dev/workspace"),
      makeRepo("/Users/dev/workspace/packages/core"),
    ];
    const result = findTrackedRepoFor("/Users/dev/workspace/packages/core/src", repos);
    expect(result?.absPath).toBe("/Users/dev/workspace/packages/core");
  });

  test("returns undefined for empty repos list", () => {
    expect(findTrackedRepoFor("/Users/dev/my-repo", [])).toBeUndefined();
  });
});
