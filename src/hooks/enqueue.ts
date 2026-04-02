import { join } from "node:path";
import { z } from "zod";
import {
  writeJob,
  jobTimestamp,
  type SessionMineJob,
} from "../daemon/jobs.ts";
import { readStdin } from "../cli/args.ts";
import { hiveRoot } from "../ctx/store.ts";

const HookPayloadSchema = z.object({
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  reason: z.string().optional(),
});

function makeJobId(prefix: string): string {
  return `${jobTimestamp()}-${prefix}`;
}

/** Fire-and-forget HTTP nudge to the daemon so it drains pending jobs immediately. */
async function nudgeDaemon(): Promise<void> {
  try {
    let port = 3939;
    try {
      const content = await Bun.file(join(hiveRoot(), "daemon.port")).text();
      const parsed = parseInt(content.trim(), 10);
      if (parsed > 0) port = parsed;
    } catch { /* port file missing — use default */ }
    await fetch(`http://localhost:${String(port)}/api/jobs/nudge`, {
      method: "POST",
      signal: AbortSignal.timeout(1000),
    });
  } catch { /* daemon may be down — job stays in DB for poll pickup */ }
}

// ── Enqueue entry point ──────────────────────────────────────────────

/**
 * Reads hook payload and writes a job to the DB.
 * Usage: ctx-hive enqueue <job-type> [args...]
 */
export async function enqueue(args: string[]): Promise<void> {
  const jobType = args[0];
  if (jobType == null || jobType === "") {
    console.error("Usage: ctx-hive enqueue <job-type>");
    process.exit(1);
  }

  if (jobType === "session-mine") {
    await enqueueSessionMine();
  } else {
    console.error(`Unknown job type: ${jobType}`);
    process.exit(1);
  }
}

// ── session-mine ─────────────────────────────────────────────────────

async function enqueueSessionMine(): Promise<void> {
  const raw = await readStdin();
  if (!raw) {
    console.error("No input received on stdin");
    process.exit(1);
  }

  let payload: z.infer<typeof HookPayloadSchema>;
  try {
    payload = HookPayloadSchema.parse(JSON.parse(raw));
  } catch {
    console.error("Invalid JSON on stdin");
    process.exit(1);
  }

  const transcriptFile = Bun.file(payload.transcript_path);
  if (!(await transcriptFile.exists())) {
    process.exit(0);
  }

  const prefix = (payload.session_id ?? "unknown").slice(0, 8);

  const job: SessionMineJob = {
    type: "session-mine",
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
    reason: payload.reason,
    createdAt: new Date().toISOString(),
  };

  writeJob(job, makeJobId(prefix));
  await nudgeDaemon();
}
