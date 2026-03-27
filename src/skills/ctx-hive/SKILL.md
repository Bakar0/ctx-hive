---
name: ctx-hive
description: Search the Memory Hive for organizational knowledge, project memories, architectural decisions, and past findings.
---

# Memory Hive

A persistent memory store for organizational knowledge, project memories, and personal notes that persists across Claude sessions.

## When to use

- Before making architectural decisions — check if there are existing standards or past decisions
- When reviewing unfamiliar code — check for project-specific conventions
- When you encounter a pattern you're unsure about — search for prior memories
- When the user asks you to remember or recall something from past sessions

## How to search

```bash
ctx-hive search "<your query>" --format markdown --limit 5
```

Filter by scope, tags, or project:
```bash
ctx-hive search "<query>" --scope org --tags "auth,security" --format markdown
```

## How to view a full entry

```bash
ctx-hive show <id-or-slug>
```

## How to list all entries

```bash
ctx-hive list
ctx-hive list --scope project --tags "api"
```

## Output

Search returns ranked results with titles, tags, scores, and excerpts. Use `ctx-hive show <id>` to read the full entry if an excerpt looks relevant.
