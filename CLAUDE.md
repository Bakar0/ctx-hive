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

## Storage patterns

- Entries are Markdown files with YAML frontmatter under `~/.ctx-hive/entries/{scope}/` (scopes: `project`, `org`, `personal`).
- Frontmatter fields: `id`, `title`, `scope`, `tags`, `project`, `created`, `updated`.
- Job queue is file-based under `~/.ctx-hive/jobs/{pending,processing,done,failed}/`.
- Job types are zod discriminated unions: `session-mine`, `git-push`, `git-pull`, `repo-sync`.

## Linting

- oxlint with strict type-aware rules: `no-floating-promises`, `no-unsafe-*`, `strict-boolean-expressions` (see `.oxlintrc.json`).
- Use `oxlint-disable-next-line` for suppression — not `eslint-disable`.
- Run `bun run lint` to check, `bun run typecheck` for tsc.

## Testing

- Co-located tests: `foo.test.ts` next to `foo.ts`.
- Import `test`, `expect`, `describe`, `beforeEach` from `bun:test`.
- Run a single test file: `bun test src/path/to/file.test.ts`.
