Default to using Bun instead of Node.js. Use `bun` / `bun test` / `bun install` / `bun run <script>` — not Node, npm, yarn, or pnpm equivalents. Bun automatically loads `.env`, so don't use dotenv.

## Commands

```
bun run dev -- <command> [args]   # Run from source (note the -- separator)
bun run lint                      # oxlint with type-aware rules
bun run typecheck                 # bunx tsc --noEmit
bun run build                     # Compile to standalone binary
bun run deploy                    # Build + copy to ~/.local/bin/
```

## Bun APIs

- `Bun.serve()` for HTTP + WebSocket server. Don't use express.
- `Bun.file(path).text()` / `Bun.file(path).json()` and `Bun.write()` for file I/O. Prefer over `node:fs` readFile/writeFile.
- `Bun.spawn()` for subprocesses. Don't use execa.
- `ServerWebSocket` from bun for WebSocket handling. Don't use `ws`.

## Code conventions

- Imports use explicit `.ts` extensions (tsconfig has `allowImportingTsExtensions`).
- `import { z } from "zod"` — this project uses zod v4.
- CLI argument parsing uses hand-rolled `getFlag`/`hasFlag` helpers in `src/cli/args.ts` — no yargs or commander.
- Text asset imports use `with { type: "text" }` (e.g., `import html from "./dashboard.html" with { type: "text" }`).
- IMPORTANT: When spawning a Claude subprocess, delete `CLAUDECODE` from env to prevent recursive Claude Code invocation (see `src/adapter/claude.ts`).

## Dashboard styling

- Use Tailwind utility classes and shadcn-svelte components. Only write custom CSS as a last resort, and document why in a comment above the rule.

## Storage patterns

- Entries are Markdown files with YAML frontmatter under `~/.ctx-hive/entries/{scope}/` (scopes: `project`, `org`, `personal`).
- Frontmatter fields: `id`, `title`, `scope`, `tags`, `project`, `created`, `updated`.
- SQLite database at `~/.ctx-hive/ctx-hive.db` stores jobs, pipeline executions, search history, and the entry search index (FTS5).
- Job types are zod discriminated unions: `session-mine`, `git-push`, `git-pull`, `repo-sync`.

## Database

- `bun:sqlite` for all database access — don't use better-sqlite3 or other wrappers.
- Connection singleton in `src/db/connection.ts` (WAL mode, 5s busy timeout, foreign keys on).
- Migrations in `src/db/migrate.ts`. Tables: `entries`, `jobs`, `pipeline_executions`, `pipeline_stages`, `pipeline_messages`, `search_history`.
- FTS5 virtual table `entries_fts` for full-text search on entries.

## Pipeline system

- Four pipelines defined in `src/pipeline/definitions.ts`: `session-mine`, `git-push`, `git-pull`, `repo-sync`.
- Stage definitions implement `StageDef` interface from `src/pipeline/schema.ts`.
- Stages grouped by domain in `src/pipeline/stages/`: `session.ts`, `git.ts`, `repo.ts`.
- Executor (`src/pipeline/executor.ts`) supports serial + parallel steps, retries with configurable delays, and abort signals.

## Linting

- oxlint with strict type-aware rules: `no-floating-promises`, `no-unsafe-*`, `strict-boolean-expressions` (see `.oxlintrc.json`).
- Never use `oxlint-disable` or `eslint-disable` comments. Fix the underlying type issue instead.
- Run `bun run lint` to check, `bun run typecheck` for tsc.

## Testing

- Co-located tests: `foo.test.ts` next to `foo.ts`.
- Import `test`, `expect`, `describe`, `beforeEach` from `bun:test`.
- Run a single test file: `bun test src/path/to/file.test.ts`.
