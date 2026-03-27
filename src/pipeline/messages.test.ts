import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { openDb, setDb } from "../db/connection.ts";
import {
  writeMessage,
  readMessage,
  messageExists,
  writeManifest,
  readManifest,
  listExecutionIds,
  cleanupMessages,
  canonicalStageName,
} from "./messages.ts";
import { PipelineExecutionSchema, type PipelineExecution } from "./schema.ts";

const TEST_EXEC_ID = "test-exec-001";

function createTestExecution(): void {
  writeManifest(TEST_EXEC_ID, {
    id: TEST_EXEC_ID, pipelineName: "test", status: "running",
    jobId: "test", project: "proj", startedAt: "2026-01-01",
    stages: [],
  } satisfies PipelineExecution);
}

describe("messages", () => {
  beforeEach(() => {
    const db = openDb(":memory:");
    setDb(db);
  });

  afterEach(() => {
    const prev = setDb(null);
    prev?.close();
  });

  test("writeMessage and readMessage round-trip", () => {
    createTestExecution();
    const data = { foo: "bar", count: 42 };
    writeMessage(TEST_EXEC_ID, "ingest", data);

    const result = readMessage(TEST_EXEC_ID, "ingest");
    expect(result).toEqual(data);
  });

  test("messageExists returns true for existing message", () => {
    createTestExecution();
    writeMessage(TEST_EXEC_ID, "prepare", { test: true });
    expect(messageExists(TEST_EXEC_ID, "prepare")).toBe(true);
  });

  test("messageExists returns false for non-existing message", () => {
    expect(messageExists(TEST_EXEC_ID, "nonexistent")).toBe(false);
  });

  test("writeManifest and readManifest round-trip", () => {
    const manifest: PipelineExecution = {
      id: TEST_EXEC_ID,
      pipelineName: "test-pipeline",
      status: "running",
      jobId: "test",
      project: "test-project",
      startedAt: "2026-01-01T00:00:00.000Z",
      stages: [
        { name: "ingest", status: "completed", retryCount: 0, metrics: {} },
      ],
    };
    writeManifest(TEST_EXEC_ID, manifest);

    const result = PipelineExecutionSchema.parse(readManifest(TEST_EXEC_ID));
    expect(result.id).toBe(TEST_EXEC_ID);
    expect(result.status).toBe("running");
    expect(result.pipelineName).toBe("test-pipeline");
  });

  test("listExecutionIds includes created execution", () => {
    writeManifest(TEST_EXEC_ID, {
      id: TEST_EXEC_ID, pipelineName: "test", status: "running",
      jobId: "test", project: "proj", startedAt: "2026-01-01",
      stages: [],
    } satisfies PipelineExecution);
    const ids = listExecutionIds();
    expect(ids).toContain(TEST_EXEC_ID);
  });

  test("cleanupMessages removes execution", () => {
    writeManifest(TEST_EXEC_ID, {
      id: TEST_EXEC_ID, pipelineName: "test", status: "running",
      jobId: "test", project: "proj", startedAt: "2026-01-01",
      stages: [],
    } satisfies PipelineExecution);
    writeMessage(TEST_EXEC_ID, "ingest", { data: true });

    cleanupMessages(TEST_EXEC_ID);

    expect(messageExists(TEST_EXEC_ID, "ingest")).toBe(false);
    const ids = listExecutionIds();
    expect(ids).not.toContain(TEST_EXEC_ID);
  });

  test("readMessage falls back to legacy stage name files", () => {
    createTestExecution();
    // Write with legacy name, read with canonical name
    writeMessage(TEST_EXEC_ID, "scan", { legacy: true });
    const result = readMessage(TEST_EXEC_ID, "ingest");
    expect(result).toEqual({ legacy: true });
  });

  test("messageExists falls back to legacy stage name files", () => {
    createTestExecution();
    writeMessage(TEST_EXEC_ID, "collect", { legacy: true });
    expect(messageExists(TEST_EXEC_ID, "summarize")).toBe(true);
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
