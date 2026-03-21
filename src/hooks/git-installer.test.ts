import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HOOK_SCRIPTS, embedBinaryPath } from "./git-scripts.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ctx-hive-git-hooks-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("HOOK_SCRIPTS exports all three hooks", () => {
  expect(Object.keys(HOOK_SCRIPTS)).toEqual(["pre-push", "post-merge", "post-rewrite"]);
});

test("each hook script starts with shebang", () => {
  for (const [_name, script] of Object.entries(HOOK_SCRIPTS)) {
    expect(script.trimStart().startsWith("#!/bin/sh")).toBe(true);
  }
});

test("each hook script contains ctx-hive enqueue", () => {
  expect(HOOK_SCRIPTS["pre-push"]).toContain("enqueue git-push");
  expect(HOOK_SCRIPTS["post-merge"]).toContain("enqueue git-pull");
  expect(HOOK_SCRIPTS["post-rewrite"]).toContain("enqueue git-pull");
});

test("each hook script chains to per-repo hooks", () => {
  expect(HOOK_SCRIPTS["pre-push"]).toContain(".git/hooks/pre-push");
  expect(HOOK_SCRIPTS["post-merge"]).toContain(".git/hooks/post-merge");
  expect(HOOK_SCRIPTS["post-rewrite"]).toContain(".git/hooks/post-rewrite");
});

test("embedBinaryPath replaces CTX_HIVE_BIN placeholder", () => {
  const script = "#!/bin/sh\nCTX_HIVE_BIN enqueue git-push\nCTX_HIVE_BIN --version";
  const result = embedBinaryPath(script, "/usr/local/bin/ctx-hive");
  expect(result).toBe("#!/bin/sh\n/usr/local/bin/ctx-hive enqueue git-push\n/usr/local/bin/ctx-hive --version");
  expect(result).not.toContain("CTX_HIVE_BIN");
});

test("pre-push script runs ctx-hive in background", () => {
  // The & ensures ctx-hive doesn't block the push
  expect(HOOK_SCRIPTS["pre-push"]).toContain("2>/dev/null &");
});

test("post-merge script passes trigger merge", () => {
  expect(HOOK_SCRIPTS["post-merge"]).toContain("--trigger merge");
});

test("post-rewrite script passes trigger rebase", () => {
  expect(HOOK_SCRIPTS["post-rewrite"]).toContain("--trigger rebase");
});

test("all hook scripts capture and pass HEAD SHA", () => {
  for (const [_name, script] of Object.entries(HOOK_SCRIPTS)) {
    expect(script).toContain('HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"');
    expect(script).toContain("--head-sha");
  }
});

test("pre-push script buffers stdin for chaining", () => {
  expect(HOOK_SCRIPTS["pre-push"]).toContain('STDIN_DATA="$(cat)"');
});

test("post-rewrite script buffers stdin for chaining", () => {
  expect(HOOK_SCRIPTS["post-rewrite"]).toContain('STDIN_DATA="$(cat)"');
});

test("hook scripts are valid shell syntax", async () => {
  for (const [name, template] of Object.entries(HOOK_SCRIPTS)) {
    const script = embedBinaryPath(template, "/usr/local/bin/ctx-hive");
    const scriptPath = join(tempDir, name);
    await Bun.write(scriptPath, script);

    const proc = Bun.spawn(["sh", "-n", scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const _stderr = await new Response(proc.stderr).text();
    expect(exitCode).toBe(0);
  }
});
