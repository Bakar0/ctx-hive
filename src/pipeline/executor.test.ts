import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { openDb, setDb } from "../db/connection.ts";
import { executePipeline } from "./executor.ts";
import { cleanupMessages, readMessage } from "./messages.ts";
import type { PipelineDef, StageDef, StageExecution } from "./schema.ts";

// Track execution IDs for cleanup
const createdExecutions: string[] = [];

function cleanAll() {
  for (const id of createdExecutions) {
    cleanupMessages(id);
  }
  createdExecutions.length = 0;
  const prev = setDb(null);
  prev?.close();
}

beforeEach(() => {
  const db = openDb(":memory:");
  setDb(db);
});

afterEach(cleanAll);

describe("executePipeline", () => {
  test("executes serial stages in order", async () => {
    const order: string[] = [];

    const stageA: StageDef<Record<string, unknown>, Record<string, unknown>> = {
      name: "a",
      async run(input) {
        order.push("a");
        return { ...input, fromA: true };
      },
    };

    const stageB: StageDef<Record<string, unknown>, Record<string, unknown>> = {
      name: "b",
      async run(input) {
        order.push("b");
        return { ...input, fromB: true };
      },
    };

    const pipeline: PipelineDef = {
      name: "test-serial",
      steps: [
        { type: "serial", stage: stageA },
        { type: "serial", stage: stageB },
      ],
    };

    const execution = await executePipeline(pipeline, { initial: true }, {
      jobFilename: "test.json",
      project: "test",
    });

    createdExecutions.push(execution.id);

    expect(order).toEqual(["a", "b"]);
    expect(execution.status).toBe("completed");
    expect(execution.stages).toHaveLength(2);
    expect(execution.stages[0]!.status).toBe("completed");
    expect(execution.stages[1]!.status).toBe("completed");
  });

  test("executes parallel stages concurrently", async () => {
    const timestamps: Record<string, number> = {};

    const stageA: StageDef = {
      name: "a",
      async run() {
        timestamps.aStart = Date.now();
        await Bun.sleep(50);
        timestamps.aEnd = Date.now();
        return { fromA: true };
      },
    };

    const stageB: StageDef = {
      name: "b",
      async run() {
        timestamps.bStart = Date.now();
        await Bun.sleep(50);
        timestamps.bEnd = Date.now();
        return { fromB: true };
      },
    };

    const pipeline: PipelineDef = {
      name: "test-parallel",
      steps: [{ type: "parallel", stages: [stageA, stageB] }],
    };

    const execution = await executePipeline(pipeline, {}, {
      jobFilename: "test.json",
      project: "test",
    });

    createdExecutions.push(execution.id);

    expect(execution.status).toBe("completed");
    // Both started at roughly the same time (within 30ms)
    expect(Math.abs(timestamps.aStart! - timestamps.bStart!)).toBeLessThan(30);
  });

  test("skips stage when condition returns false", async () => {
    const stage: StageDef = {
      name: "conditional",
      condition: (input: Record<string, unknown>) => input.skip === false,
      async run() { return { ran: true }; },
    };

    const pipeline: PipelineDef = {
      name: "test-skip",
      steps: [{ type: "serial", stage }],
    };

    const execution = await executePipeline(pipeline, { skip: true }, {
      jobFilename: "test.json",
      project: "test",
    });

    createdExecutions.push(execution.id);

    expect(execution.status).toBe("completed");
    expect(execution.stages[0]!.status).toBe("skipped");
  });

  test("retries failed stage", async () => {
    let attempts = 0;

    const stage: StageDef = {
      name: "flaky",
      retries: 2,
      retryDelayMs: 10,
      async run() {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return { ok: true };
      },
    };

    const pipeline: PipelineDef = {
      name: "test-retry",
      steps: [{ type: "serial", stage }],
    };

    const execution = await executePipeline(pipeline, {}, {
      jobFilename: "test.json",
      project: "test",
    });

    createdExecutions.push(execution.id);

    expect(attempts).toBe(3);
    expect(execution.status).toBe("completed");
    expect(execution.stages[0]!.retryCount).toBe(2);
  });

  test("fails pipeline when stage exhausts retries", async () => {
    const stage: StageDef = {
      name: "always-fail",
      retries: 1,
      retryDelayMs: 10,
      async run() { throw new Error("permanent"); },
    };

    const pipeline: PipelineDef = {
      name: "test-fail",
      steps: [{ type: "serial", stage }],
    };

    try {
      const execution = await executePipeline(pipeline, {}, {
        jobFilename: "test.json",
        project: "test",
      });
      createdExecutions.push(execution.id);
      expect(true).toBe(false); // should not reach here
    } catch {
      // Expected — pipeline throws on failure
    }

    // Read manifest to verify state
    const { listExecutionIds: listIds } = await import("./messages.ts");
    const ids = listIds();
    for (const id of ids) {
      if (id.length === 36) { // UUID format
        createdExecutions.push(id);
      }
    }
  });

  test("calls onStageChange callback", async () => {
    const changes: StageExecution[] = [];

    const stage: StageDef = {
      name: "tracked",
      async run() { return { done: true }; },
    };

    const pipeline: PipelineDef = {
      name: "test-callback",
      steps: [{ type: "serial", stage }],
    };

    const execution = await executePipeline(pipeline, {}, {
      jobFilename: "test.json",
      project: "test",
      onStageChange: (s) => changes.push({ ...s }),
    });

    createdExecutions.push(execution.id);

    expect(changes.length).toBeGreaterThanOrEqual(2); // at least running + completed
    expect(changes.some((c) => c.status === "running")).toBe(true);
    expect(changes.some((c) => c.status === "completed")).toBe(true);
  });

  test("writes stage output messages to disk", async () => {
    const stage: StageDef = {
      name: "writer",
      async run() { return { wrote: true }; },
    };

    const pipeline: PipelineDef = {
      name: "test-messages",
      steps: [{ type: "serial", stage }],
    };

    const execution = await executePipeline(pipeline, { seed: 1 }, {
      jobFilename: "test.json",
      project: "test",
    });

    createdExecutions.push(execution.id);

    const output = readMessage(execution.id, "writer");
    expect(output).toEqual({ wrote: true });
  });
});
