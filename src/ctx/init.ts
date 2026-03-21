import { readdir, stat } from "node:fs/promises";
import { join, relative, basename, resolve } from "node:path";
import { loadIndex, type IndexEntry } from "./store.ts";
import { getSessionFilePaths } from "./sessions.ts";
import { runParallel, type PipelineTask } from "../utils/pipeline.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface RepoInfo {
  name: string;
  absPath: string;
  relPath: string;
}

export interface RepoMeta {
  name: string;
  org: string;
  remoteUrl: string;
}

export interface RepoContext {
  readme: string;
  claudeMd: string;
}

// ── Arg parsing ────────────────────────────────────────────────────────

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// ── Repo scanning ──────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
]);

/**
 * Recursively find git repos (directories containing .git) up to maxDepth.
 */
export async function scanForRepos(
  rootPath: string,
  maxDepth: number = 4,
): Promise<RepoInfo[]> {
  const root = resolve(rootPath);
  const repos: RepoInfo[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    if (entries.includes(".git")) {
      // Check that .git is a directory (not a file, which indicates a submodule worktree)
      try {
        const gitStat = await stat(join(dir, ".git"));
        if (gitStat.isDirectory()) {
          repos.push({
            name: basename(dir),
            absPath: dir,
            relPath: relative(root, dir) || ".",
          });
        }
      } catch {
        // skip
      }
    }

    // Continue scanning subdirectories for nested repos
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      if (entry.startsWith(".")) continue; // skip hidden dirs

      const fullPath = join(dir, entry);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          await walk(fullPath, depth + 1);
        }
      } catch {
        // skip inaccessible
      }
    }
  }

  await walk(root, 0);
  return repos;
}

// ── Interactive selection ──────────────────────────────────────────────

// ANSI helpers
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";

function renderCheckboxList(repos: RepoInfo[], checked: boolean[], cursor: number): void {
  const header = `${BOLD}Select repos to initialize${RESET}  ${DIM}(↑↓ move · space toggle · a all · enter confirm · q quit)${RESET}\n`;
  const rows = repos.map((repo, i) => {
    const isCursor = i === cursor;
    const isChecked = checked[i] === true;
    const dot = isChecked ? `${CYAN}◉${RESET}` : `${DIM}○${RESET}`;
    const arrow = isCursor ? `${GREEN}>${RESET}` : " ";
    const name = repo.name.padEnd(24);
    const path = `${DIM}${repo.relPath}${RESET}`;
    return `${arrow} ${dot}  ${name} ${path}`;
  });

  process.stdout.write(header + rows.join("\n"));
}

function clearLines(n: number): void {
  // Move up n lines and erase each
  for (let i = 0; i < n; i++) {
    process.stdout.write("\x1b[2K\x1b[1A");
  }
  process.stdout.write("\x1b[2K"); // erase the top line too
}

/**
 * Simple fallback selection when stdin is not a TTY (piped input).
 */
async function simpleSelect(repos: RepoInfo[]): Promise<RepoInfo[]> {
  console.log("\nSelect repos to initialize (comma-separated numbers, or 'all'):\n");
  for (let i = 0; i < repos.length; i++) {
    console.log(`  ${i + 1}. ${repos[i]!.name.padEnd(25)} ${repos[i]!.relPath}`);
  }
  process.stdout.write("\nSelection [all]: ");
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const answer = new TextDecoder().decode(value).trim().toLowerCase();
  if (answer === "" || answer === "all") return repos;
  const indices = answer
    .split(",")
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < repos.length);
  if (indices.length === 0) {
    console.log("No valid selection. Exiting.");
    return [];
  }
  return indices.map((i) => repos[i]!);
}

/**
 * Present an interactive TUI checkbox list.
 * Arrow keys move, space toggles, enter confirms, q/ctrl-c aborts.
 * Falls back to simple numbered selection if not a TTY.
 */
export async function interactiveSelect(repos: RepoInfo[]): Promise<RepoInfo[]> {
  if (repos.length === 0) return [];
  if (repos.length === 1) {
    console.log(`Found 1 repo: ${repos[0]!.name} (${repos[0]!.relPath})`);
    return repos;
  }

  // Fall back to simple selection when not a TTY
  if (!process.stdin.isTTY) {
    return simpleSelect(repos);
  }

  const checked = repos.map(() => false); // start with none selected
  let cursor = 0;
  // header (1) + repos (n) lines rendered
  const totalLines = 1 + repos.length;

  // Initial render
  renderCheckboxList(repos, checked, cursor);

  const restoreTerminal = () => {
    try {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {
      // ignore if already restored
    }
    process.stdout.write("\n");
  };

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (key: string) => {
      const code = key.charCodeAt(0);

      // Ctrl+C
      if (code === 3) {
        restoreTerminal();
        process.stdin.off("data", onData);
        resolve([]);
        return;
      }

      // q — quit
      if (key === "q" || key === "Q") {
        restoreTerminal();
        process.stdin.off("data", onData);
        resolve([]);
        return;
      }

      // Enter — confirm
      if (key === "\r" || key === "\n") {
        restoreTerminal();
        process.stdin.off("data", onData);
        resolve(repos.filter((_, i) => checked[i] === true));
        return;
      }

      // Space — toggle current
      if (key === " ") {
        checked[cursor] = checked[cursor] !== true;
      }

      // Arrow up
      if (key === "\x1b[A") {
        cursor = (cursor - 1 + repos.length) % repos.length;
      }

      // Arrow down
      if (key === "\x1b[B") {
        cursor = (cursor + 1) % repos.length;
      }

      // 'a' — toggle all
      if (key === "a" || key === "A") {
        const anyUnchecked = checked.some((c) => !c);
        for (let i = 0; i < checked.length; i++) checked[i] = anyUnchecked;
      }

      // Re-render: clear previous output then redraw
      clearLines(totalLines);
      renderCheckboxList(repos, checked, cursor);
    };

    process.stdin.on("data", onData);
  });
}

// ── Repo metadata ──────────────────────────────────────────────────────

/**
 * Extract repo name and org from git remote URL.
 */
export async function resolveRepoMeta(repoPath: string): Promise<RepoMeta> {
  const fallback: RepoMeta = { name: basename(repoPath), org: "", remoteUrl: "" };

  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const remoteUrl = text.trim();
    if (remoteUrl === "") return fallback;

    // Parse org/name from URL
    // ssh: git@github.com:org/repo.git
    // https: https://github.com/org/repo.git
    const sshMatch = /[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl);
    if (sshMatch !== null) {
      return { name: sshMatch[2]!, org: sshMatch[1]!, remoteUrl };
    }

    return { ...fallback, remoteUrl };
  } catch {
    return fallback;
  }
}

// ── Gather repo context ────────────────────────────────────────────────

export async function gatherRepoContext(repoPath: string): Promise<RepoContext> {
  let readme = "";
  let claudeMd = "";

  const readmeFile = Bun.file(join(repoPath, "README.md"));
  if (await readmeFile.exists()) {
    const full = await readmeFile.text();
    readme = full.slice(0, 5000); // cap at 5KB
  }

  const claudeMdFile = Bun.file(join(repoPath, "CLAUDE.md"));
  if (await claudeMdFile.exists()) {
    const full = await claudeMdFile.text();
    claudeMd = full.slice(0, 5000);
  }

  return { readme, claudeMd };
}

// ── Check existing context ─────────────────────────────────────────────

export async function checkExistingContext(
  projectName: string,
): Promise<IndexEntry[]> {
  const index = await loadIndex();
  return index.filter(
    (e) =>
      e.project === projectName ||
      e.title.toLowerCase().includes(projectName.toLowerCase()),
  );
}

// ── Prompt building ────────────────────────────────────────────────────

function existingEntriesBlock(existing: IndexEntry[], isUpdate: boolean): string {
  if (existing.length === 0) return "";
  const lines = existing.map(
    (e) => `- [${e.scope}] ${e.title} (id: ${e.id}, tags: ${e.tags.join(",")})`,
  );
  return `\n## Existing Context Entries (${existing.length})\n\n${lines.join("\n")}${
    isUpdate
      ? "\n\nThis is an UPDATE run. Review existing entries above. Delete outdated ones and add/update as needed."
      : ""
  }`;
}

function ctxAddInstructions(meta: RepoMeta, isUpdate: boolean): string {
  return `### How to add entries:
For short entries:
\`\`\`
ctx-hive add --title "Entry title" --scope project --tags "tag1,tag2" --project "${meta.name}" --body "Entry body content here"
\`\`\`

For longer entries, write the body to a temp file first:
\`\`\`
cat > /tmp/ctx-entry-body.txt << 'ENTRYEOF'
Multi-line entry body content here.
Can span multiple lines.
ENTRYEOF
ctx-hive add --title "Entry title" --scope project --tags "tag1,tag2" --project "${meta.name}" --file /tmp/ctx-entry-body.txt
\`\`\`
${isUpdate ? "\nTo delete outdated entries:\n```\nctx-hive delete <id> --force\n```" : ""}`;
}

/**
 * Build prompt for the Repo Analyzer agent.
 */
export function buildRepoPrompt(
  meta: RepoMeta,
  repoContext: RepoContext,
  existing: IndexEntry[],
  isUpdate: boolean,
): string {
  const sections: string[] = [];

  sections.push(`# Repo Analyzer: ${meta.name}`);
  sections.push(`\nOrg: ${meta.org !== "" ? meta.org : "(unknown)"}`);
  if (meta.remoteUrl !== "") sections.push(`Remote: ${meta.remoteUrl}`);

  if (repoContext.readme !== "") {
    sections.push(`\n## README.md\n\n${repoContext.readme}`);
  }

  if (repoContext.claudeMd !== "") {
    sections.push(`\n## CLAUDE.md\n\n${repoContext.claudeMd}`);
  }

  sections.push(existingEntriesBlock(existing, isUpdate));

  sections.push(`
## Instructions

You are analyzing the repository "${meta.name}" to generate Context Hive entries based on the **code and architecture**.

### Your task:
1. **Explore the repository** — use Glob, Grep, and Read to understand the codebase structure, key patterns, architecture decisions, and conventions.
2. **Generate context entries** using \`ctx-hive add\` for each insight worth preserving.

### Focus areas:
- Architecture decisions and patterns (why things are structured this way)
- Key abstractions and conventions (naming, file organization, error handling)
- Non-obvious gotchas or constraints
- Cross-cutting concerns (auth, logging, error handling patterns)
- Build/deploy/test conventions not captured in CLAUDE.md

### Scope definitions:
- **project**: Specific to this repo — architecture, patterns, key decisions, gotchas
- **org**: Cross-repo patterns — shared conventions, infrastructure, team practices

### Rules:
- Each entry must be **self-contained** — useful without additional context
- Focus on **decisions, patterns, and conventions** — not code snippets
- Don't duplicate what's already in CLAUDE.md
- Use descriptive titles and relevant tags
- Keep entry bodies concise but informative (3-10 lines)
- Generate 5-10 entries
- For project-scope entries, always include --project "${meta.name}"

${ctxAddInstructions(meta, isUpdate)}

Now explore the repository and generate context entries.`);

  return sections.join("\n");
}

/**
 * Build prompt for the Session Miner agent.
 */
export function buildSessionPrompt(
  meta: RepoMeta,
  sessionPaths: string[],
  existing: IndexEntry[],
  isUpdate: boolean,
): string {
  const fileList = sessionPaths.map((p) => `- ${p}`).join("\n");

  return `# Session Miner: ${meta.name}

You are mining past Claude Code session histories for the project "${meta.name}" to extract valuable context worth persisting.

## Session files (JSONL format, newest first)

${fileList}

## JSONL format

Each line is a JSON object. Relevant message types:
- \`{"type": "human", "message": {"content": "..."}}\` — user messages
- \`{"type": "assistant", "message": {"content": [...]}}\` — assistant messages (content is an array of blocks, look for \`type: "text"\`)

Skip these:
- \`type: "system"\` — system messages
- \`type: "tool_use"\`, \`type: "tool_result"\` — tool interactions (low signal)
- \`type: "result"\` — final metrics
- Messages containing "file-history-snapshot", "Tool loaded.", or "/clear"

## How to read sessions efficiently

1. Start by reading the first ~200 lines and last ~100 lines of each session file to get an overview
2. Identify sessions that contain substantive discussions (decisions, explanations, debugging insights)
3. For promising sessions, read more deeply to extract the key insights

${existingEntriesBlock(existing, isUpdate)}

## What to extract

Look for:
- **Decisions made** — "we decided to use X because Y", "let's go with approach A"
- **Recurring themes** — topics that come up across multiple sessions
- **Developer preferences** — coding style, tool preferences, workflow patterns
- **Debugging insights** — "the issue was X, the fix was Y" (if it reveals a pattern)
- **Architecture discussions** — why things were built a certain way
- **Gotchas discovered** — "watch out for X when doing Y"

### Scope definitions:
- **project**: Specific to this repo — discovered patterns, decisions, gotchas
- **org**: Cross-repo patterns — shared conventions, team practices
- **personal**: Developer preferences — workflow habits, tool preferences, coding style

### Rules:
- Each entry must be **self-contained** — useful without additional context
- Focus on **insights and decisions** — not conversation summaries
- Use descriptive titles and relevant tags
- Keep entry bodies concise but informative (3-10 lines)
- Generate 3-8 entries
- For project-scope entries, always include --project "${meta.name}"

${ctxAddInstructions(meta, isUpdate)}

Now read the session files and generate context entries.`;
}

// ── Process a single repo ──────────────────────────────────────────────

interface ProcessResult {
  repoName: string;
  cost_usd: number;
  duration_ms: number;
  errors: string[];
}

async function processRepo(
  repo: RepoInfo,
  options: {
    noSessions: boolean;
    maxSessions: number;
    dryRun: boolean;
    verbose: boolean;
  },
): Promise<ProcessResult> {
  const { noSessions, maxSessions, dryRun, verbose } = options;

  if (verbose) console.log(`\n→ Processing: ${repo.name} (${repo.absPath})`);

  // 1. Resolve metadata
  const meta = await resolveRepoMeta(repo.absPath);
  if (verbose) console.log(`  Org: ${meta.org !== "" ? meta.org : "(none)"}, Remote: ${meta.remoteUrl !== "" ? meta.remoteUrl : "(none)"}`);

  // 2. Gather repo context
  const repoContext = await gatherRepoContext(repo.absPath);
  if (verbose) {
    console.log(`  README: ${repoContext.readme !== "" ? "found" : "none"}`);
    console.log(`  CLAUDE.md: ${repoContext.claudeMd !== "" ? "found" : "none"}`);
  }

  // 3. Check existing context
  const existing = await checkExistingContext(meta.name);
  const isUpdate = existing.length > 0;
  if (verbose) console.log(`  Existing entries: ${existing.length} (${isUpdate ? "update" : "init"} mode)`);

  // 4. Discover session files
  let sessionPaths: string[] = [];
  if (!noSessions) {
    sessionPaths = await getSessionFilePaths(repo.absPath, maxSessions);
    if (verbose) console.log(`  Session files: ${sessionPaths.length}`);
  }

  // 5. Build prompts
  const repoPrompt = buildRepoPrompt(meta, repoContext, existing, isUpdate);
  const sessionPrompt = !noSessions && sessionPaths.length > 0
    ? buildSessionPrompt(meta, sessionPaths, existing, isUpdate)
    : null;

  // 6. Dry run — print both prompts and return
  if (dryRun) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`DRY RUN: ${repo.name} (${isUpdate ? "update" : "init"} mode)`);
    console.log(`${"─".repeat(60)}`);
    console.log(`\n── Agent 1: Repo Analyzer ──\n`);
    console.log(repoPrompt);
    if (sessionPrompt !== null) {
      console.log(`\n── Agent 2: Session Miner ──\n`);
      console.log(sessionPrompt);
    } else {
      console.log(`\n── Agent 2: Session Miner (skipped — ${noSessions ? "disabled" : "no sessions found"}) ──`);
    }
    return { repoName: repo.name, cost_usd: 0, duration_ms: 0, errors: [] };
  }

  // 7. Build tasks and run in parallel
  const tasks: PipelineTask<unknown>[] = [
    {
      name: `repo-analyzer-${repo.name}`,
      options: {
        name: `repo-analyzer-${repo.name}`,
        prompt: repoPrompt,
        cwd: repo.absPath,
        model: "sonnet",
        allowedTools: ["Bash", "Read", "Glob", "Grep"],
        logsDir: "logs",
      },
    },
  ];

  if (sessionPrompt !== null) {
    tasks.push({
      name: `session-miner-${repo.name}`,
      options: {
        name: `session-miner-${repo.name}`,
        prompt: sessionPrompt,
        cwd: repo.absPath,
        model: "sonnet",
        allowedTools: ["Bash", "Read", "Glob", "Grep"],
        logsDir: "logs",
      },
    });
  }

  if (verbose) {
    const agentNames = tasks.map((t) => t.name).join(", ");
    console.log(`  Spawning ${tasks.length} agent(s): ${agentNames}`);
  }

  try {
    const result = await runParallel(tasks);

    const errors: string[] = [];
    for (const r of result.results) {
      if (r.error !== undefined) {
        console.error(`  ✗ ${r.name}: ${r.error}`);
        errors.push(`${r.name}: ${r.error}`);
      } else if (verbose) {
        console.log(`  ✓ ${r.name} — $${r.cost_usd.toFixed(4)} (${(r.duration_ms / 1000).toFixed(1)}s)`);
      }
    }

    console.log(`  ${errors.length === 0 ? "✓" : "⚠"} ${repo.name} — $${result.total_cost_usd.toFixed(4)} (${(result.total_duration_ms / 1000).toFixed(1)}s)`);
    return {
      repoName: repo.name,
      cost_usd: result.total_cost_usd,
      duration_ms: result.total_duration_ms,
      errors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${repo.name}: ${msg}`);
    return { repoName: repo.name, cost_usd: 0, duration_ms: 0, errors: [msg] };
  }
}

// ── Main orchestrator ──────────────────────────────────────────────────

export async function ctxInit(args: string[]): Promise<void> {
  const noSessions = hasFlag(args, "--no-sessions");
  const maxSessions = parseInt(getFlag(args, "--max-sessions") ?? "10", 10);
  const dryRun = hasFlag(args, "--dry-run");
  const verbose = hasFlag(args, "--verbose");
  const all = hasFlag(args, "--all");

  // Determine root path: first non-flag arg, or cwd
  const rootPath = args.find((a) => !a.startsWith("--") && a !== "init" && a !== "update") ?? process.cwd();

  // 1. Scan for repos
  if (verbose) console.log(`Scanning for repos in: ${rootPath}`);
  const repos = await scanForRepos(rootPath);

  if (repos.length === 0) {
    console.log("No git repositories found.");
    return;
  }

  if (verbose) console.log(`Found ${repos.length} repo(s)`);

  // 2. Select repos
  let selected: RepoInfo[];
  if (all) {
    selected = repos;
    console.log(`Processing all ${repos.length} repo(s)...`);
  } else {
    selected = await interactiveSelect(repos);
  }

  if (selected.length === 0) {
    console.log("No repos selected.");
    return;
  }

  // 3. Process each repo
  const results: ProcessResult[] = [];
  for (const repo of selected) {
    const result = await processRepo(repo, { noSessions, maxSessions, dryRun, verbose });
    results.push(result);
  }

  // 4. Summary
  if (!dryRun && results.length > 0) {
    const totalCost = results.reduce((s, r) => s + r.cost_usd, 0);
    const totalTime = results.reduce((s, r) => s + r.duration_ms, 0);
    const successes = results.filter((r) => r.errors.length === 0).length;
    const failures = results.filter((r) => r.errors.length > 0).length;

    console.log(`\n${"─".repeat(40)}`);
    console.log(`Done: ${successes} succeeded, ${failures} failed`);
    console.log(`Total cost: $${totalCost.toFixed(4)}`);
    console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);

    if (failures > 0) {
      for (const r of results.filter((r) => r.errors.length > 0)) {
        for (const err of r.errors) {
          console.log(`  ✗ ${r.repoName}: ${err}`);
        }
      }
    }
  }
}
