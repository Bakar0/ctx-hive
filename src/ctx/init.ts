import { readdir, stat } from "node:fs/promises";
import { join, relative, basename, resolve } from "node:path";
import { loadIndex, type IndexEntry } from "./store.ts";
import { getSessionFilePaths } from "./sessions.ts";
import { runParallel, type PipelineTask } from "../adapter/pipeline.ts";
import { errorMessage } from "../git/run.ts";

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

import { getFlag, hasFlag } from "../cli/args.ts";

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
  for (let i = 0; i < n - 1; i++) {
    process.stdout.write("\x1b[2K\x1b[1A");
  }
  process.stdout.write("\x1b[2K\r");
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
  preloadedIndex?: IndexEntry[],
): Promise<IndexEntry[]> {
  const index = preloadedIndex ?? await loadIndex();
  return index.filter(
    (e) =>
      e.project === projectName ||
      e.title.toLowerCase().includes(projectName.toLowerCase()),
  );
}

// ── Project Overview lookup ────────────────────────────────────────────

export async function findProjectOverview(
  projectName: string,
  preloadedIndex?: IndexEntry[],
): Promise<IndexEntry | null> {
  const index = preloadedIndex ?? await loadIndex();
  return (
    index.find(
      (e) => e.project === projectName && e.tags.includes("project-overview"),
    ) ?? null
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

function buildEvaluationBlock(servedEntries: ServedEntry[]): string {
  if (servedEntries.length === 0) return "";

  const entryList = servedEntries
    .map((e) => `- id: ${e.id} — "${e.title}"`)
    .join("\n");

  return `## Additional Task: Evaluate Previously-Served Context

The following context entries were served to this session via ctx-hive search:
${entryList}

For each entry, evaluate whether it was useful in the session:
1. Was the entry referenced or acted upon?
2. Did it influence a decision or prevent a mistake?
3. Was it ignored or irrelevant to what the session was doing?

Report your evaluation for each entry by running:
\`\`\`
ctx-hive evaluate --entry-id <id> --session-id <session-id> --rating <-1|0|1|2> --reason "brief reason"
\`\`\`

Rating scale:
- **-1**: Entry was counterproductive (outdated, misleading, or caused confusion)
- **0**: Entry was irrelevant to this session's work
- **1**: Entry was referenced or acknowledged
- **2**: Entry was heavily relied upon or prevented a mistake

Do this BEFORE extracting new insights. Use the session ID from the transcript filename (without the .jsonl extension).
`;
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
 * Creates/updates the Project Overview entry + finds hidden context insights.
 */
export function buildRepoPrompt(
  meta: RepoMeta,
  repoContext: RepoContext,
  existing: IndexEntry[],
  isUpdate: boolean,
  overviewEntry?: IndexEntry | null,
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

You have TWO tasks for "${meta.name}":

### Task 1: Create/Update the Project Overview

${overviewEntry ? `An existing Project Overview entry exists (id: ${overviewEntry.id}). Read it with \`ctx-hive show ${overviewEntry.id}\`, then delete it and create an updated version.` : "No Project Overview exists yet. Create one from scratch."}

Explore the repository thoroughly (Glob, Grep, Read), then create a single entry with:
- **Title**: "Project Overview: ${meta.name}"
- **Scope**: project
- **Tags**: project-overview
- **Project**: ${meta.name}

The body MUST contain these 4 sections:

**## Architecture**
What the project does at a high level. Key components and how they connect. Tech stack and runtime. Data flow.

**## Capabilities**
What the project can do: CLI commands, API endpoints, supported integrations, features, user-facing functionality.

**## Dependencies & Boundaries**
External services, libraries, and systems this project depends on. What depends on this project. Integration contracts and protocols.

**## Recent Changes**
Leave this empty for a full scan — it will be maintained by incremental git hook updates.

${overviewEntry ? `\nTo update: first delete the old entry, then create the new one:\n\`\`\`\nctx-hive delete ${overviewEntry.id} --force\n\`\`\`` : ""}

### Task 2: Find Hidden Context Insights

After creating the Project Overview, look for insights that **cannot be derived from reading the code**:
- **Decision rationale** — WHY was this approach chosen over alternatives?
- **Gotchas and landmines** — things that look correct but break in surprising ways
- **Cross-service boundaries** — integration contracts, what happens if a dependency is down
- **Organizational constraints** — compliance requirements, security boundaries

For each insight, create a separate entry (scope: project, tags relevant to the topic).

**Do NOT create insight entries for:**
- Code structure or architecture (that's in the Project Overview)
- Build/test commands (belong in CLAUDE.md)
- How a specific function works (an AI can read the code)

### Entry format for insight entries:
- **Title**: Actionable statement or warning, not a description
  - Good: "Don't use playbooks for SIEM forwarding — 7-hop overhead and recursion risk"
  - Bad: "Export Audit Log to SIEM design decisions"
- **Body**: Lead with the insight. Then WHY. Then WHEN this matters. 3-8 lines.

### Rules:
- Always create the Project Overview (Task 1)
- Generate 0-5 insight entries (Task 2) — quality over quantity, 0 is fine
- For all entries, include --project "${meta.name}"
- Don't duplicate what's in CLAUDE.md

${ctxAddInstructions(meta, isUpdate)}

Now explore the repository, create the Project Overview, and generate insight entries if any. Start with Task 1.`);

  return sections.join("\n");
}

export interface ServedEntry {
  id: string;
  title: string;
}

/**
 * Build prompt for the Session Miner agent.
 */
export function buildSessionPrompt(
  meta: RepoMeta,
  sessionPaths: string[],
  existing: IndexEntry[],
  isUpdate: boolean,
  servedEntries: ServedEntry[] = [],
): string {
  const fileList = sessionPaths.map((p) => `- ${p}`).join("\n");

  return `# Session Miner: ${meta.name}

You are mining past Claude Code session histories for the project "${meta.name}" to extract context that **cannot be derived from reading the code**.

## The "Can't Derive From Code" test
Before creating any entry, ask: "If an AI read the entire codebase, would it still miss this?" If the answer is no, do NOT create the entry. The code already tells that story.

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
2. Look for sessions with debates, rejected approaches, or user-stated constraints
3. For promising sessions, read more deeply to extract the key insights

${existingEntriesBlock(existing, isUpdate)}

## Extract ONLY these types of insights:

1. **Rejected alternatives** — "We tried X but switched to Y because Z." The rejected path is the valuable part — it prevents someone from going down the same dead end.
   - Example: "Don't use playbooks for high-frequency event forwarding — tried it, 7-hop overhead and recursion risk made it unviable"

2. **Debugging breakthroughs** — Not "the fix was X" (that's in the commit), but "the symptom looked like A but the root cause was actually B." The diagnostic insight that saves hours next time.
   - Example: "gRPC certificate_verify_failed after mTLS migration — root cause is missing internal CA in GrpcChannelFactory, not expired certs"

3. **Cross-service discoveries** — "When service A does X, service B breaks because Y." Integration knowledge that spans repos and can't be seen from one codebase.
   - Example: "policy service must be up before scan-engine starts — scan-engine graph build fails without policy provider"

4. **Explicit constraints from the user** — "We can't do X because of compliance/legal/SLA/team capacity." Business constraints that shape technical decisions and aren't written in code.
   - Example: "LLM scanning requires explicit account opt-in for legal reasons — not a technical limitation"

## Do NOT extract:
- Code patterns or architecture descriptions (an AI can read the code)
- Generic Claude workflow tips (not project context)
- Step-by-step debugging logs (the fix is already committed)
- Implementation details of completed work (derivable from the committed code)
- Branch names, commit hashes, or session-specific ephemera
- Developer preferences like coding style (these belong in CLAUDE.md)

### Scope definitions:
- **project**: Specific to this repo — rejected approaches, debugging insights, cross-service gotchas
- **org**: Cross-repo knowledge — integration points, shared constraints, team decisions
- **personal**: User-specific constraints or context that affects how they work

### Entry format:
- **Title**: Actionable statement or warning, not a description.
  - Good: "Don't mock the database in scan-engine E2E tests — mock/prod divergence masked a broken migration last quarter"
  - Bad: "Testing patterns and decisions"
- **Body**: What was tried or discovered → Why it matters → When this applies to future work. 3-8 lines.
- Each entry must be **self-contained** — useful without additional context

### Rules:
- Generate 2-5 entries (fewer, higher quality)
- If no sessions contain insights that pass the "Can't Derive From Code" test, generate 0 entries — that's fine
- For project-scope entries, always include --project "${meta.name}"

${ctxAddInstructions(meta, isUpdate)}

${buildEvaluationBlock(servedEntries)}
Now read the session files and generate context entries. Remember: only things an AI couldn't figure out by reading the code.`;
}

// ── Git change prompt ─────────────────────────────────────────────────

export interface GitChangeDetails {
  trigger: "push" | "pull-merge" | "pull-rebase";
  commitMessages: string;
  changedFiles: string;
  diffSummary: string;
}

export function buildGitChangePrompt(
  meta: RepoMeta,
  existing: IndexEntry[],
  isUpdate: boolean,
  details: GitChangeDetails,
  overviewEntry?: IndexEntry | null,
): string {
  const triggerLabel =
    details.trigger === "push" ? "pushed commits" :
    details.trigger === "pull-merge" ? "pulled changes (merge)" :
    "pulled changes (rebase)";

  return `# Project Overview Updater: ${meta.name}

You are maintaining the Project Overview for "${meta.name}" after ${triggerLabel}.

## What changed

### Commits
${details.commitMessages || "(no commit messages available)"}

### Changed files
${details.changedFiles || "(no file list available)"}

### Diff summary
${details.diffSummary || "(no diff summary available)"}

## Instructions

${overviewEntry
  ? `A Project Overview entry exists (id: ${overviewEntry.id}). Read it with:
\`\`\`
ctx-hive show ${overviewEntry.id}
\`\`\``
  : "No Project Overview exists yet. You need to explore the repo and create one from scratch."}

### Your task:
1. ${overviewEntry ? `Read the existing Project Overview with \`ctx-hive show ${overviewEntry.id}\`` : "Explore the repository to understand its architecture and capabilities"}
2. Read the changed files to understand what was modified
3. Determine if the changes affect **Architecture**, **Capabilities**, **Dependencies & Boundaries**, or are notable enough for **Recent Changes**
4. ${overviewEntry ? "If changes are significant: delete the old entry and create an updated one. If changes are trivial (formatting, tests, minor fixes): do nothing." : "Create the Project Overview entry."}

### Project Overview entry format:
- **Title**: "Project Overview: ${meta.name}"
- **Scope**: project
- **Tags**: project-overview
- **Project**: ${meta.name}

The body MUST contain these 4 sections:

**## Architecture**
What the project does at a high level. Key components and how they connect. Tech stack and runtime.

**## Capabilities**
What the project can do: CLI commands, API endpoints, integrations, features.

**## Dependencies & Boundaries**
External services/systems this depends on. What depends on it. Integration contracts.

**## Recent Changes**
Brief summaries of notable recent changes. Keep only the last 5 entries. Add the current change at the top if it's notable.
Format: \`- [YYYY-MM-DD] Brief description of what changed\`

${overviewEntry ? `### To update:
\`\`\`
ctx-hive delete ${overviewEntry.id} --force
\`\`\`
Then create the new version with \`ctx-hive add\`.` : ""}

### Rules:
- If the changes don't affect architecture, capabilities, or dependencies, and aren't notable — **do nothing**. Routine bug fixes, test changes, and formatting don't need updates.
- When updating, preserve the existing content for sections that weren't affected by the changes.
- For the Recent Changes section, carry forward previous entries and add the new one at the top.
- Always include --project "${meta.name}" and --tags "project-overview"

${ctxAddInstructions(meta, isUpdate)}

Now analyze the changes and update the Project Overview if warranted.`;
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

  // 3. Check existing context (load index once)
  const index = await loadIndex();
  const existing = await checkExistingContext(meta.name, index);
  const isUpdate = existing.length > 0;
  const overviewEntry = await findProjectOverview(meta.name, index);
  if (verbose) console.log(`  Existing entries: ${existing.length} (${isUpdate ? "update" : "init"} mode), overview: ${overviewEntry ? overviewEntry.id : "none"}`);

  // 4. Discover session files
  let sessionPaths: string[] = [];
  if (!noSessions) {
    sessionPaths = await getSessionFilePaths(repo.absPath, maxSessions);
    if (verbose) console.log(`  Session files: ${sessionPaths.length}`);
  }

  // 5. Build prompts
  const repoPrompt = buildRepoPrompt(meta, repoContext, existing, isUpdate, overviewEntry);
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
    const msg = errorMessage(err);
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
