import {
  ensureCtxDir,
  generateId,
  writeEntry,
  readEntry,
  deleteEntry,
  loadIndex,
  rebuildIndex,
  resolveEntry,
  parseFrontmatter,
  serializeEntry,
  type EntryMeta,
  SCOPES,
  isScope,
} from "./store.ts";
import { searchMulti, formatHuman, formatJson, formatMarkdown } from "./search.ts";
import { ctxInit } from "./init.ts";
import { recordEvaluation, type RelevanceEval } from "./signals.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFlag, hasFlag } from "../cli/args.ts";

function parseTags(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

// ── Help ───────────────────────────────────────────────────────────────

function printCtxHelp() {
  console.log(`
ctx-hive — Memory Hive: persistent memory store

Usage:
  ctx-hive <subcommand> [options]

Subcommands:
  add                            Add a new memory entry
    --title <title>              Entry title (required)
    --scope <project|org|personal>  Scope (default: personal)
    --tags <t1,t2,...>           Comma-separated tags
    --project <name>             Project name (for project scope)
    --body <text>                Entry body text
    --file <path>                Read body from file

  search <query>                 Search the memory hive
    --scope <scope>              Filter by scope
    --tags <t1,t2,...>           Filter by tags
    --project <name>             Filter by project
    --limit <n>                  Max results (default: 10)
    --format <human|json|markdown>  Output format (default: human)

  list                           List all entries
    --scope <scope>              Filter by scope
    --tags <t1,t2,...>           Filter by tags
    --project <name>             Filter by project

  show <id-or-slug>              Show full entry content

  edit <id-or-slug>              Open entry in $EDITOR

  delete <id-or-slug>            Delete an entry
    --force                      Skip confirmation

  rebuild-index                  Rebuild index from entry files

  init [path]                    Auto-generate entries from repo analysis
    --no-sessions                Skip session mining (repo analysis only)
    --max-sessions <n>           Limit sessions to process (default: 10)
    --dry-run                    Show prompt without spawning Claude
    --verbose                    Show progress details
    --all                        Skip selection, init all found repos

  update [path]                  Alias for init (auto-detects existing entries)

  serve                          Start the daemon (watches for jobs)
    --verbose                    Show detailed output
    --port <n>                   Dashboard port (default: 3939)

  evaluate                       Record a relevance evaluation for an entry
    --entry-id <id>              Entry ID to evaluate (required)
    --session-id <id>            Session that was evaluated (required)
    --rating <-1|0|1|2>          Relevance rating (required)
    --reason <text>              Brief reason for the rating

  enqueue <job-type>             Enqueue a job (reads payload from stdin)

  install-hook                   Install SessionEnd hook into Claude settings
`);
}

// ── Subcommands ────────────────────────────────────────────────────────

async function ctxAdd(args: string[]): Promise<void> {
  const title = getFlag(args, "--title");
  if (title === undefined) {
    console.error("Error: --title is required");
    process.exit(1);
  }

  const scopeRaw = getFlag(args, "--scope") ?? "personal";
  if (!isScope(scopeRaw)) {
    console.error(`Error: invalid scope "${scopeRaw}". Must be one of: ${SCOPES.join(", ")}`);
    process.exit(1);
  }
  const scope = scopeRaw;

  const tags = parseTags(getFlag(args, "--tags"));
  const project = getFlag(args, "--project") ?? "";

  // Get body from --body, --file, or stdin
  let body = getFlag(args, "--body") ?? "";
  const filePath = getFlag(args, "--file");
  if (filePath !== undefined) {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      console.error(`Error: file not found: ${filePath}`);
      process.exit(1);
    }
    body = await file.text();
  }

  if (body === "") {
    console.error("Error: provide --body or --file for entry content");
    process.exit(1);
  }

  const now = new Date().toISOString();
  const meta: EntryMeta = {
    id: generateId(),
    title,
    scope,
    tags,
    project,
    created: now,
    updated: now,
    tokens: 0,
  };

  const slug = writeEntry(meta, body);
  console.log(`Added: ${scope}/${slug} (id: ${meta.id})`);
}

async function ctxSearch(args: string[]): Promise<void> {
  // Query is the first non-flag argument after "search"
  const query = args.find((a) => !a.startsWith("--") && a !== "search");
  if (query === undefined) {
    console.error("Error: search query required. Usage: ctx-hive search <query>");
    process.exit(1);
  }

  const scopeFlag = getFlag(args, "--scope");
  const scope = scopeFlag !== undefined && isScope(scopeFlag) ? scopeFlag : undefined;
  const tags = parseTags(getFlag(args, "--tags"));
  const project = getFlag(args, "--project");
  const limit = parseInt(getFlag(args, "--limit") ?? "10", 10);
  const format = getFlag(args, "--format") ?? "human";

  const { merged } = await searchMulti(query, { scope, tags: tags.length > 0 ? tags : undefined, project }, limit, { source: "cli" });

  if (format === "json") {
    console.log(formatJson(merged, query));
  } else if (format === "markdown") {
    console.log(formatMarkdown(merged));
  } else {
    console.log(formatHuman(merged));
  }
}

function ctxList(args: string[]): void {
  const index = loadIndex();

  let entries = index;
  const scopeFlag = getFlag(args, "--scope");
  const scope = scopeFlag !== undefined && isScope(scopeFlag) ? scopeFlag : undefined;
  if (scope !== undefined) entries = entries.filter((e) => e.scope === scope);

  const tags = parseTags(getFlag(args, "--tags"));
  if (tags.length > 0) {
    const filterTags = tags.map((t) => t.toLowerCase());
    entries = entries.filter((e) =>
      filterTags.some((ft) => e.tags.map((t) => t.toLowerCase()).includes(ft))
    );
  }

  const project = getFlag(args, "--project");
  if (project !== undefined) entries = entries.filter((e) => e.project === project);

  if (entries.length === 0) {
    console.log("No entries found.");
    return;
  }

  for (const e of entries) {
    const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
    const tok = e.tokens > 0 ? `  ${e.tokens} tok` : "";
    console.log(`${e.id}  ${e.scope.padEnd(8)}  ${e.title}${tags}${tok}`);
  }
}

function ctxShow(args: string[]): void {
  const idOrSlug = args.find((a) => !a.startsWith("--") && a !== "show");
  if (idOrSlug === undefined) {
    console.error("Error: provide an id or slug. Usage: ctx-hive show <id-or-slug>");
    process.exit(1);
  }

  const resolved = resolveEntry(idOrSlug);
  if (resolved === null) {
    console.error(`Error: entry not found: ${idOrSlug}`);
    process.exit(1);
  }

  const entry = readEntry(resolved.scope, resolved.slug);
  const tags = entry.tags.length > 0 ? `\nTags: ${entry.tags.join(", ")}` : "";
  const tok = entry.tokens > 0 ? `  Tokens: ${entry.tokens}` : "";
  console.log(`# ${entry.title}\nScope: ${entry.scope}  ID: ${entry.id}${tok}${tags}\n\n${entry.body}`);
}

async function ctxEdit(args: string[]): Promise<void> {
  const idOrSlug = args.find((a) => !a.startsWith("--") && a !== "edit");
  if (idOrSlug === undefined) {
    console.error("Error: provide an id or slug. Usage: ctx-hive edit <id-or-slug>");
    process.exit(1);
  }

  const resolved = resolveEntry(idOrSlug);
  if (resolved === null) {
    console.error(`Error: entry not found: ${idOrSlug}`);
    process.exit(1);
  }

  const entry = readEntry(resolved.scope, resolved.slug);
  const serialized = serializeEntry(entry, entry.body);

  // Write to temp file, open in editor, parse result back into DB
  const tmpPath = join(tmpdir(), `ctx-hive-edit-${resolved.slug}.md`);
  await Bun.write(tmpPath, serialized);

  const editor = process.env.EDITOR ?? "vi";
  const proc = Bun.spawn([editor, tmpPath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  const raw = await Bun.file(tmpPath).text();
  const parsed = parseFrontmatter(raw);
  parsed.meta.updated = new Date().toISOString();
  writeEntry(parsed.meta, parsed.body);

  console.log(`Updated: ${resolved.scope}/${resolved.slug}`);
}

async function ctxDelete(args: string[]): Promise<void> {
  const idOrSlug = args.find((a) => !a.startsWith("--") && a !== "delete");
  if (idOrSlug === undefined) {
    console.error("Error: provide an id or slug. Usage: ctx-hive delete <id-or-slug>");
    process.exit(1);
  }

  const resolved = resolveEntry(idOrSlug);
  if (resolved === null) {
    console.error(`Error: entry not found: ${idOrSlug}`);
    process.exit(1);
  }

  if (!hasFlag(args, "--force")) {
    process.stdout.write(`Delete ${resolved.scope}/${resolved.slug}? (y/N) `);
    const reader = Bun.stdin.stream().getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const answer = new TextDecoder().decode(value).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("Cancelled.");
      return;
    }
  }

  deleteEntry(resolved.scope, resolved.slug);
  console.log(`Deleted: ${resolved.scope}/${resolved.slug}`);
}

type Rating = -1 | 0 | 1 | 2;
function isValidRating(n: number): n is Rating {
  return n === -1 || n === 0 || n === 1 || n === 2;
}

function ctxEvaluate(args: string[]): void {
  const entryId = getFlag(args, "--entry-id");
  if (entryId === undefined) {
    console.error("Error: --entry-id is required");
    process.exit(1);
  }

  const sessionId = getFlag(args, "--session-id");
  if (sessionId === undefined) {
    console.error("Error: --session-id is required");
    process.exit(1);
  }

  const ratingStr = getFlag(args, "--rating");
  if (ratingStr === undefined) {
    console.error("Error: --rating is required (-1, 0, 1, or 2)");
    process.exit(1);
  }
  const rating = parseInt(ratingStr, 10);
  if (!isValidRating(rating)) {
    console.error("Error: --rating must be -1, 0, 1, or 2");
    process.exit(1);
  }

  const reason = getFlag(args, "--reason");

  const evaluation: RelevanceEval = {
    evaluatedAt: new Date().toISOString(),
    sessionId,
    rating,
    ...(reason !== undefined ? { reason } : {}),
  };

  recordEvaluation(entryId, evaluation);
  console.log(`Evaluated: entry ${entryId} rated ${rating} for session ${sessionId.slice(0, 8)}`);
}

function ctxRebuildIndex(): void {
  const entries = rebuildIndex();
  console.log(`Index rebuilt: ${entries.length} entries`);
}

// ── Main dispatch ──────────────────────────────────────────────────────

export async function ctx(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    printCtxHelp();
    return;
  }

  await ensureCtxDir();

  switch (subcommand) {
    case "add":
      return ctxAdd(args.slice(1));
    case "search":
      return ctxSearch(args.slice(1));
    case "list":
      return ctxList(args.slice(1));
    case "show":
      return ctxShow(args.slice(1));
    case "edit":
      return ctxEdit(args.slice(1));
    case "delete":
      return ctxDelete(args.slice(1));
    case "evaluate":
      return ctxEvaluate(args.slice(1));
    case "rebuild-index":
      return ctxRebuildIndex();
    case "init":
    case "update":
      return ctxInit(args.slice(1));
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printCtxHelp();
      process.exit(1);
  }
}
