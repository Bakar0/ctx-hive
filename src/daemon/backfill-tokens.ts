import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DONE_DIR, FAILED_DIR } from "./jobs.ts";
import { extractTranscriptTokens } from "./handlers.ts";

/**
 * One-time migration: re-calculate _transcriptTokens for all completed
 * session-mine jobs using actual usage data from the transcript JSONL.
 */
export async function backfillTranscriptTokens(): Promise<void> {
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const dir of [DONE_DIR, FAILED_DIR]) {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }

    for (const file of files) {
      const path = join(dir, file);
      try {
        const raw = await Bun.file(path).text();
        const job: unknown = JSON.parse(raw);
        if (
          typeof job !== "object" || job === null ||
          !("type" in job) || job.type !== "session-mine" ||
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

        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) { skipped++; continue; }
        const data: Record<string, unknown> = { ...parsed };
        const old = typeof data._transcriptTokens === "number" ? data._transcriptTokens : undefined;
        data._transcriptTokens = tokens;
        await Bun.write(path, JSON.stringify(data, null, 2));
        console.log(`${file}: ${old ?? "none"} → ${tokens}`);
        updated++;
      } catch {
        console.error(`Failed: ${file}`);
        failed++;
      }
    }
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}`);
}
