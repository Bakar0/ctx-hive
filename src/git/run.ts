/**
 * Run a git command and return trimmed stdout. Returns "" on any error.
 */
export async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.trim();
  } catch {
    return "";
  }
}

/**
 * Extract a human-readable message from an unknown caught error.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
