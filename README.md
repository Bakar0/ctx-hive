# ctx-hive

[![CI](https://github.com/Bakar0/ctx-hive/actions/workflows/ci.yml/badge.svg)](https://github.com/Bakar0/ctx-hive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Persistent context store for Claude Code sessions.

ctx-hive lets you save, search, and reuse organizational knowledge, project context, architectural decisions, and personal notes across Claude Code sessions. It acts as institutional memory — so you never lose the "why" behind code patterns, conventions, and past decisions.

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI — for skill integration, session hooks, and init/update features

## Quick start

```bash
git clone https://github.com/Bakar0/ctx-hive.git
cd ctx-hive
bun install
bun run dev -- search "your query"
```

## Installation

1. **Clone and install dependencies**

   ```bash
   git clone https://github.com/Bakar0/ctx-hive.git
   cd ctx-hive
   bun install
   ```

2. **Build and deploy**

   ```bash
   bun run deploy    # Compiles binary and copies to ~/.local/bin/ctx-hive
   ```

3. **Ensure `~/.local/bin` is in your PATH**

   If `which ctx-hive` returns nothing, add this to your shell profile (`~/.zshrc` or `~/.bashrc`):

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   ```

   Then reload: `source ~/.zshrc` (or restart your terminal).

4. **Install integrations**

   ```bash
   ctx-hive install-skill        # Register as a Claude Code skill
   ctx-hive install-hook          # Auto-mine sessions when Claude Code exits
   ctx-hive install-git-hooks     # Enqueue jobs on git push/pull/rebase
   ```

5. **Start the daemon**

   ```bash
   ctx-hive serve
   ```

   The daemon processes background jobs and serves the dashboard at `http://localhost:3939`.

## Usage

```
ctx-hive <command> [options]

Commands:
  search <query>         Search entries by keyword
  add                    Create a new context entry
  list                   List all entries
  show <id>              Display a full entry
  edit <id>              Open an entry in $EDITOR
  delete <id>            Remove an entry
  init [path]            Scan repos and mine Claude sessions for context
  update [path]          Update existing entries (alias for init)
  evaluate               Record a relevance evaluation for an entry
  rebuild-index          Regenerate the search index
  serve                  Start the background daemon and dashboard
  enqueue <job-type>     Enqueue a job for the daemon
  install-skill          Install the Claude Code skill
  install-hook           Install SessionEnd hook into Claude settings
  install-git-hooks      Install global git hooks (pre-push, post-merge, post-rewrite)
  uninstall-git-hooks    Remove global git hooks

Options:
  -v, --version          Show version
```

### Search

```bash
ctx-hive search "auth middleware" --format markdown --limit 5
ctx-hive search "api design" --scope org --tags "rest,graphql"
```

Search uses weighted scoring — tag matches rank highest (5x), then title matches (3x), then content (1x). Results include excerpts with matched context.

### Init / Update

```bash
ctx-hive init
```

Scans your directory tree for git repos, lets you select which ones to analyze, then spawns parallel agents to:

1. **Analyze the repo** — explores code structure, extracts architecture decisions and patterns
2. **Mine Claude sessions** — parses past session history for insights and discussions

Results are saved as searchable context entries.

### Daemon & Dashboard

```bash
ctx-hive serve                     # Start daemon + dashboard
ctx-hive serve --port 4000         # Custom dashboard port
ctx-hive serve --verbose           # Detailed logging
```

The daemon polls for pending jobs in SQLite and processes them via the pipeline execution engine. A web dashboard is served at `http://localhost:3939` with live WebSocket updates.

**Job types:** `session-mine`, `git-push`, `git-pull`, `repo-sync`

**Job lifecycle:** `pending` -> `processing` -> `done` or `failed` (tracked in SQLite at `~/.ctx-hive/ctx-hive.db`)

Each job runs a multi-stage pipeline (ingest → prepare → extract → summarize) with retry support. Only one daemon instance runs at a time (PID file lock).

### Hooks

**Session hook** — automatically enqueues a `session-mine` job when a Claude Code session ends:

```bash
ctx-hive install-hook
```

**Git hooks** — enqueue jobs on push/pull events across all repos:

```bash
ctx-hive install-git-hooks           # Install pre-push, post-merge, post-rewrite
ctx-hive uninstall-git-hooks         # Remove hooks
ctx-hive uninstall-git-hooks --clean # Remove hooks + delete scripts
```

Git hooks are fire-and-forget — they never block git operations.

## Entry scopes

| Scope | Purpose |
|-------|---------|
| **project** | Context specific to a single repo |
| **org** | Shared knowledge across an organization |
| **personal** | Personal notes and preferences |

## Storage

Entries are stored as Markdown files with YAML frontmatter under `~/.ctx-hive/`, organized by scope. SQLite FTS5 provides full-text search.

## Architecture

```
src/
├── adapter/    Claude CLI subprocess adapter (spawn, stream-parse)
├── cli/        CLI argument parsing
├── ctx/        Core logic — commands, search, store, init, sessions, signals
├── daemon/     Background daemon — serve, job queue, handlers, REST API, WebSocket
├── db/         SQLite database — connection, migrations, FTS5 search index
├── git/        Git subprocess execution
├── hooks/      Git & session hooks — enqueue, installers, hook scripts
├── inject/     UserPromptSubmit hook — searches context and injects into Claude prompts
├── pipeline/   Pipeline execution — stage definitions, executor, message passing
├── repo/       Repo scanning & tracking
├── skills/     Claude Code skill definition & installer
├── types/      TypeScript declarations
└── index.ts    Entry point
```

- **Commands** (`src/ctx/commands.ts`) — CLI dispatcher routing to handler functions
- **Store** (`src/ctx/store.ts`) — Entry CRUD with frontmatter parsing
- **Search** (`src/ctx/search.ts`) — Full-text search with FTS5-backed weighted ranking
- **Init** (`src/ctx/init.ts`) — Repo scanning and parallel agent execution
- **Sessions** (`src/ctx/sessions.ts`) — Claude session file discovery
- **Database** (`src/db/`) — SQLite connection, migrations, FTS5 search index
- **Pipeline** (`src/pipeline/`) — Execution engine with serial/parallel stages, retries, abort signals
- **Daemon** (`src/daemon/serve.ts`) — Background job processor with HTTP dashboard
- **Jobs** (`src/daemon/jobs.ts`) — SQLite-backed job queue with zod-validated schemas
- **Inject** (`src/inject/hook.ts`) — UserPromptSubmit hook for context injection into Claude prompts
- **Hooks** (`src/hooks/`) — SessionEnd hook and global git hook installers
- **Repo tracking** (`src/repo/tracking.ts`) — Track/untrack repos for context generation

## Development

```bash
bun install              # Install dependencies
bun run dev              # Run from source
bun test                 # Run tests
bun run lint             # Lint with oxlint (type-aware)
bun run typecheck        # Type check
bun run build            # Compile to standalone binary
bun run build:linux-x64  # Cross-compile for Linux x64
bun run deploy           # Build + copy to ~/.local/bin/
```

## License

MIT
