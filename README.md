# ctx-hive

[![CI](https://github.com/Bakar0/ctx-hive/actions/workflows/ci.yml/badge.svg)](https://github.com/Bakar0/ctx-hive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Persistent context store for Claude Code sessions.

ctx-hive lets you save, search, and reuse organizational knowledge, project context, architectural decisions, and personal notes across Claude Code sessions. It acts as institutional memory — so you never lose the "why" behind code patterns, conventions, and past decisions.

## Quick start

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/Bakar0/ctx-hive.git
cd ctx-hive
bun install
bun run dev -- search "your query"
```

### Install globally

```bash
bun run build
sudo cp ctx-hive /usr/local/bin/ctx-hive
```

### Install the Claude Code skill

```bash
ctx-hive install-skill
```

This registers ctx-hive as a skill so Claude automatically searches your context hive when making architectural decisions or reviewing unfamiliar code.

## Usage

```
ctx-hive <command> [options]

Commands:
  search <query>       Search entries by keyword
  add                  Create a new context entry
  list                 List all entries
  show <id>            Display a full entry
  edit <id>            Open an entry in $EDITOR
  delete <id>          Remove an entry
  init                 Scan repos and mine Claude sessions for context
  update               Update existing entries (alias for init)
  rebuild-index        Regenerate the search index
  install-skill        Install the Claude Code skill

Options:
  -v, --version        Show version
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

## Entry scopes

| Scope | Purpose |
|-------|---------|
| **project** | Context specific to a single repo |
| **org** | Shared knowledge across an organization |
| **personal** | Personal notes and preferences |

## Storage

Entries are stored as Markdown files with YAML frontmatter under `~/.ctx-hive/`, organized by scope. A JSON index enables fast search.

## Architecture

```
src/
├── adapter/       Claude CLI subprocess adapter
├── ctx/           Core logic — commands, search, store, init, sessions
├── shared/        Path utilities
├── skills/        Claude Code skill definition
├── types/         TypeScript declarations
├── utils/         Logging, pipeline, skill installer
└── index.ts       Entry point
```

- **Commands** (`src/ctx/commands.ts`) — CLI dispatcher routing to handler functions
- **Store** (`src/ctx/store.ts`) — Entry CRUD with frontmatter parsing
- **Search** (`src/ctx/search.ts`) — Full-text search with token-based weighted ranking
- **Init** (`src/ctx/init.ts`) — Repo scanning and parallel agent execution
- **Sessions** (`src/ctx/sessions.ts`) — Claude session file discovery

## Requirements

- [Bun](https://bun.sh) runtime
- Claude Code (for skill integration and init/update agent features)

## Development

```bash
bun install          # Install dependencies
bun run dev          # Run from source
bun test             # Run tests
bun run typecheck    # Type check
bun run build        # Compile to standalone binary
```

## License

MIT
