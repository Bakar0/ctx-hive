/**
 * UserPromptSubmit hook handler.
 * Reads the hook payload from stdin, searches ctx-hive for relevant context,
 * and returns JSON with additionalContext for Claude to see.
 */
import { basename, join } from "node:path";
import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { search, tokenize, type SearchResult } from "../ctx/search.ts";
import { hiveRoot } from "../ctx/store.ts";

// ── Constants ──────────────────────────────────────────────────────────

const DAEMON_URL = "http://localhost:3939";
const DAEMON_TIMEOUT_MS = 1500;
const HARD_TIMEOUT_MS = 2000;
const MAX_RESULTS = 5;
const MIN_SCORE_THRESHOLD = 0.2;
const MIN_QUERY_TOKENS = 3;

// ── Hook payload schema ────────────────────────────────────────────────

const HookPayloadSchema = z.object({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  hook_event_name: z.string().optional(),
  prompt: z.string(),
}).passthrough();

// ── Formatting ─────────────────────────────────────────────────────────

function formatInjectResult(results: SearchResult[]): string {
  if (results.length === 0) return "";

  const entries = results.map((r) => {
    const tags = r.tags.length > 0 ? `\nTags: ${r.tags.join(", ")}` : "";
    return `### ${r.title}\n**id:** ${r.id} | **scope:** ${r.scope} | **relevance:** ${r.score} | **tokens:** ${r.tokens} | **source:** inject${tags}\n\n${r.excerpt}`;
  });

  return [
    "[ctx-hive] Relevant context from your organization's knowledge base:",
    "",
    ...entries.join("\n\n---\n\n").split("\n"),
    "",
    "---",
    'Use `ctx-hive search "<query>"` or `ctx-hive show <id>` for full entries.',
  ].join("\n");
}

// ── Daemon search (fast path) ──────────────────────────────────────────

async function tryDaemonSearch(
  query: string,
  project?: string,
): Promise<SearchResult[] | null> {
  try {
    const params = new URLSearchParams({ q: query, limit: String(MAX_RESULTS), source: "inject" });
    if (project !== undefined && project !== "") params.set("project", project);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DAEMON_TIMEOUT_MS);

    const resp = await fetch(`${DAEMON_URL}/api/search?${params.toString()}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return null;
    const DaemonSearchResultSchema = z.object({
      results: z.array(z.object({
        id: z.string(),
        title: z.string(),
        scope: z.enum(["project", "org", "personal"]),
        tags: z.array(z.string()),
        project: z.string(),
        created: z.string(),
        updated: z.string(),
        tokens: z.number().optional().default(0),
        path: z.string(),
        score: z.number(),
        excerpt: z.string(),
      })),
    });
    const data = DaemonSearchResultSchema.parse(await resp.json());
    return data.results;
  } catch {
    return null;
  }
}

// ── Main handler ───────────────────────────────────────────────────────

export async function handleInject(): Promise<void> {
  const hardTimeout = setTimeout(() => {
    console.log("{}");
    process.exit(0);
  }, HARD_TIMEOUT_MS);

  try {
    // Read stdin using Bun.file(0) which handles EOF better in compiled binaries
    const raw = await Bun.file("/dev/stdin").text().then((s) => s.trim());

    // Debug log: always append raw payload for troubleshooting
    const debugPath = join(hiveRoot(), "inject-debug.log");
    void appendFile(debugPath, `[${new Date().toISOString()}] raw=${raw}\n`);

    if (!raw) {
      console.log("{}");
      return;
    }

    let payload: z.infer<typeof HookPayloadSchema>;
    try {
      payload = HookPayloadSchema.parse(JSON.parse(raw));
    } catch (err) {
      void appendFile(debugPath, `[${new Date().toISOString()}] parse-error=${String(err)}\n`);
      console.log("{}");
      return;
    }

    // Extract prompt text
    const promptText = payload.prompt;

    // Short-circuit on short prompts
    const tokens = tokenize(promptText);
    if (tokens.length < MIN_QUERY_TOKENS) {
      console.log("{}");
      return;
    }

    const project = payload.cwd !== undefined && payload.cwd !== "" ? basename(payload.cwd) : undefined;
    const sessionId = payload.session_id;

    // Try daemon first, fall back to direct search
    let results = await tryDaemonSearch(promptText, project);
    results ??= await search(promptText, { project }, MAX_RESULTS, {
      source: "inject",
      project,
      cwd: payload.cwd,
      sessionId,
    });

    // Filter by minimum score threshold
    results = results.filter((r) => r.score >= MIN_SCORE_THRESHOLD);

    if (results.length === 0) {
      console.log("{}");
      return;
    }

    const additionalContext = formatInjectResult(results);
    console.log(JSON.stringify({ additionalContext }));
  } catch {
    console.log("{}");
  } finally {
    clearTimeout(hardTimeout);
  }
}
