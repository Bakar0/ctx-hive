import { getDb } from "../db/connection.ts";
import { extractTranscriptTokens } from "./handlers.ts";

/**
 * One-time migration: re-calculate _transcriptTokens for all completed
 * session-mine jobs using actual usage data from the transcript JSONL.
 */
export async function backfillTranscriptTokens(): Promise<void> {
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  const db = getDb();
  const rows = db.prepare<{ job_id: string; payload: string }, [string]>(
    "SELECT job_id, payload FROM jobs WHERE status IN ('done', 'failed') AND type = ?",
  ).all("session-mine");

  for (const row of rows) {
    try {
      const job: unknown = JSON.parse(row.payload);
      if (
        typeof job !== "object" || job === null ||
        !("transcriptPath" in job) || typeof job.transcriptPath !== "string"
      ) {
        skipped++;
        continue;
      }

      const tokens = await extractTranscriptTokens(job.transcriptPath);
      if (tokens === undefined) {
        skipped++;
        continue;
      }

      db.prepare("UPDATE jobs SET transcript_tokens = ? WHERE job_id = ?")
        .run(tokens, row.job_id);
      console.log(`${row.job_id}: → ${tokens}`);
      updated++;
    } catch {
      console.error(`Failed: ${row.job_id}`);
      failed++;
    }
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}`);
}
