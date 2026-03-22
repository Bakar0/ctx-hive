import {
  ensureCtxDir,
  generateId,
  writeEntry,
  readEntry,
  deleteEntry,
  loadIndex,
  rebuildIndex,
  resolveEntry,
  type EntryMeta,
  SCOPES,
  isScope,
  hiveRoot,
} from "./store.ts";
import { search, formatHuman, formatJson, formatMarkdown } from "./search.ts";
import { ctxInit } from "./init.ts";
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
ctx-hive — Context Hive: persistent context store

Usage:
  ctx-hive <subcommand> [options]

Subcommands:
  add                            Add a new context entry
    --title <title>              Entry title (required)
    --scope <project|org|personal>  Scope (default: personal)
    --tags <t1,t2,...>           Comma-separated tags
    --project <name>             Project name (for project scope)
    --body <text>                Entry body text
    --file <path>                Read body from file

  search <query>                 Search the context hive
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
  };

  const slug = await writeEntry(meta, body);
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

  const results = await search(query, { scope, tags: tags.length > 0 ? tags : undefined, project }, limit);

  if (format === "json") {
    console.log(formatJson(results, query));
  } else if (format === "markdown") {
    console.log(formatMarkdown(results));
  } else {
    console.log(formatHuman(results));
  }
}

async function ctxList(args: string[]): Promise<void> {
  const index = await loadIndex();

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
    console.log(`${e.id}  ${e.scope.padEnd(8)}  ${e.title}${tags}`);
  }
}

async function ctxShow(args: string[]): Promise<void> {
  const idOrSlug = args.find((a) => !a.startsWith("--") && a !== "show");
  if (idOrSlug === undefined) {
    console.error("Error: provide an id or slug. Usage: ctx-hive show <id-or-slug>");
    process.exit(1);
  }

  const resolved = await resolveEntry(idOrSlug);
  if (resolved === null) {
    console.error(`Error: entry not found: ${idOrSlug}`);
    process.exit(1);
  }

  const entry = await readEntry(resolved.scope, resolved.slug);
  const tags = entry.tags.length > 0 ? `\nTags: ${entry.tags.join(", ")}` : "";
  console.log(`# ${entry.title}\nScope: ${entry.scope}  ID: ${entry.id}${tags}\n\n${entry.body}`);
}

async function ctxEdit(args: string[]): Promise<void> {
  const idOrSlug = args.find((a) => !a.startsWith("--") && a !== "edit");
  if (idOrSlug === undefined) {
    console.error("Error: provide an id or slug. Usage: ctx-hive edit <id-or-slug>");
    process.exit(1);
  }

  const resolved = await resolveEntry(idOrSlug);
  if (resolved === null) {
    console.error(`Error: entry not found: ${idOrSlug}`);
    process.exit(1);
  }

  const editor = process.env.EDITOR ?? "vi";
  const filePath = join(hiveRoot(), "entries", resolved.scope, `${resolved.slug}.md`);

  const proc = Bun.spawn([editor, filePath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  // Update the "updated" timestamp in frontmatter
  const raw = await Bun.file(filePath).text();
  const updated = raw.replace(
    /^(updated: ").*(")/m,
    `$1${new Date().toISOString()}$2`
  );
  await Bun.write(filePath, updated);

  await rebuildIndex();
  console.log(`Updated: ${resolved.scope}/${resolved.slug}`);
}

async function ctxDelete(args: string[]): Promise<void> {
  const idOrSlug = args.find((a) => !a.startsWith("--") && a !== "delete");
  if (idOrSlug === undefined) {
    console.error("Error: provide an id or slug. Usage: ctx-hive delete <id-or-slug>");
    process.exit(1);
  }

  const resolved = await resolveEntry(idOrSlug);
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

  await deleteEntry(resolved.scope, resolved.slug);
  console.log(`Deleted: ${resolved.scope}/${resolved.slug}`);
}

async function ctxRebuildIndex(): Promise<void> {
  const entries = await rebuildIndex();
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
