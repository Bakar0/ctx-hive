import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** Root directory where Claude stores per-project session data. */
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Directory where Claude stores per-PID session identity files (<pid>.json). */
export const CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/** Claude Code user settings file. */
export const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/**
 * Encode an absolute path to match Claude's session directory naming.
 * /Users/foo/myrepo -> -Users-foo-myrepo
 */
export function encodePath(repoPath: string): string {
  const abs = resolve(repoPath);
  return abs.replace(/\//g, "-");
}

/**
 * Decode a Claude session directory name back to an absolute path.
 * -Users-foo-myrepo -> /Users/foo/myrepo
 */
export function decodePath(encoded: string): string {
  return encoded.replace(/-/g, "/");
}

/**
 * Return the full Claude session directory path for a repo.
 */
export function projectSessionDir(repoPath: string): string {
  return join(CLAUDE_PROJECTS_DIR, encodePath(repoPath));
}
