import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  writeMessage,
  readMessage,
  messageExists,
  writeManifest,
  readManifest,
  listExecutionIds,
  cleanupMessages,
  createExecutionDir,
  messagesRoot,
  canonicalStageName,
} from "./messages.ts";

const TEST_EXEC_ID = "test-exec-001";

describe("messages", () => {
  beforeEach(async () => {
    await mkdir(messagesRoot(), { recursive: true });
    await createExecutionDir(TEST_EXEC_ID);
  });

  afterEach(async () => {
    await cleanupMessages(TEST_EXEC_ID);
  });

  test("writeMessage and readMessage round-trip", async () => {
    const data = { foo: "bar", count: 42 };
    await writeMessage(TEST_EXEC_ID, "ingest", data);

    const result = await readMessage(TEST_EXEC_ID, "ingest");
    expect(result).toEqual(data);
  });

  test("messageExists returns true for existing message", async () => {
    await writeMessage(TEST_EXEC_ID, "prepare", { test: true });
    expect(await messageExists(TEST_EXEC_ID, "prepare")).toBe(true);
  });

  test("messageExists returns false for non-existing message", async () => {
    expect(await messageExists(TEST_EXEC_ID, "nonexistent")).toBe(false);
  });

  test("writeManifest and readManifest round-trip", async () => {
    const manifest = { id: TEST_EXEC_ID, status: "running", stages: [] };
    await writeManifest(TEST_EXEC_ID, manifest);

    const result = await readManifest(TEST_EXEC_ID);
    expect(result).toEqual(manifest);
  });

  test("listExecutionIds includes created execution", async () => {
    const ids = await listExecutionIds();
    expect(ids).toContain(TEST_EXEC_ID);
  });

  test("cleanupMessages removes execution directory", async () => {
    await cleanupMessages(TEST_EXEC_ID);
    expect(await messageExists(TEST_EXEC_ID, "ingest")).toBe(false);
    const ids = await listExecutionIds();
    expect(ids).not.toContain(TEST_EXEC_ID);
  });

  test("writeMessage includes metadata in envelope", async () => {
    await writeMessage(TEST_EXEC_ID, "extract", { result: "ok" }, { inputTokens: 100 });

    const raw = await Bun.file(
      join(messagesRoot(), TEST_EXEC_ID, "extract.out.json"),
    ).text();
    // oxlint-disable-next-line no-unsafe-assignment -- test assertion on JSON
    const envelope: Record<string, unknown> = JSON.parse(raw);
    expect(envelope.timestamp).toBeDefined();
    expect(envelope.stageName).toBe("extract");
    expect(envelope.data).toEqual({ result: "ok" });
    expect(envelope.metrics).toEqual({ inputTokens: 100 });
  });

  test("readMessage falls back to legacy stage name files", async () => {
    // Write with legacy name, read with canonical name
    await writeMessage(TEST_EXEC_ID, "scan", { legacy: true });
    const result = await readMessage(TEST_EXEC_ID, "ingest");
    expect(result).toEqual({ legacy: true });
  });

  test("messageExists falls back to legacy stage name files", async () => {
    await writeMessage(TEST_EXEC_ID, "collect", { legacy: true });
    expect(await messageExists(TEST_EXEC_ID, "summarize")).toBe(true);
  });

  test("canonicalStageName maps legacy names correctly", () => {
    expect(canonicalStageName("scan")).toBe("ingest");
    expect(canonicalStageName("gather")).toBe("ingest");
    expect(canonicalStageName("inject")).toBe("prepare");
    expect(canonicalStageName("mine")).toBe("extract");
    expect(canonicalStageName("analyze")).toBe("extract");
    expect(canonicalStageName("collect")).toBe("summarize");
    expect(canonicalStageName("evaluate")).toBe("evaluate");
    expect(canonicalStageName("ingest")).toBe("ingest");
  });
});
