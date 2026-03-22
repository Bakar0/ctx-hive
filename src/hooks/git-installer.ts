import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, chmod, rm } from "node:fs/promises";
import { ensureJobDirs } from "../daemon/jobs.ts";
import { HOOK_SCRIPTS, embedBinaryPath, type GitHookName } from "./git-scripts.ts";

const GIT_HOOKS_DIR = join(homedir(), ".ctx-hive", "git-hooks");

async function getGlobalHooksPath(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "config", "--global", "core.hooksPath"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return text.trim() || null;
  } catch {
    return null;
  }
}

async function resolveCtxHiveBin(): Promise<string> {
  // Use the currently running binary's path
  return process.argv[0] ?? "ctx-hive";
}

export async function installGitHooks(args: string[]): Promise<void> {
  const force = args.includes("--force");

  // 1. Ensure job directories exist
  await ensureJobDirs();

  // 2. Check existing core.hooksPath
  const currentPath = await getGlobalHooksPath();
  if (currentPath === GIT_HOOKS_DIR) {
    console.log("Git hooks are already installed.");
    console.log(`  Hooks dir: ${GIT_HOOKS_DIR}`);
    return;
  }

  if (currentPath != null && currentPath !== "" && currentPath !== GIT_HOOKS_DIR) {
    if (!force) {
      console.error(`core.hooksPath is already set to: ${currentPath}`);
      console.error("Use --force to override, or manually integrate ctx-hive hooks.");
      process.exit(1);
    }
    console.log(`Warning: overriding existing core.hooksPath (was: ${currentPath})`);
  }

  // 3. Resolve binary path
  const binPath = await resolveCtxHiveBin();

  // 4. Create hooks directory
  await mkdir(GIT_HOOKS_DIR, { recursive: true });

  // 5. Write each hook script
  for (const [hookName, template] of Object.entries(HOOK_SCRIPTS)) {
    const script = embedBinaryPath(template, binPath);
    const hookPath = join(GIT_HOOKS_DIR, hookName);
    await Bun.write(hookPath, script);
    await chmod(hookPath, 0o755);
  }

  // 6. Set global core.hooksPath
  const proc = Bun.spawn(
    ["git", "config", "--global", "core.hooksPath", GIT_HOOKS_DIR],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`Failed to set core.hooksPath: ${stderr}`);
    process.exit(1);
  }

  console.log("Git hooks installed successfully.");
  console.log(`  Hooks dir:  ${GIT_HOOKS_DIR}`);
  console.log(`  Hooks:      ${Object.keys(HOOK_SCRIPTS).join(", ")}`);
  console.log(`  Binary:     ${binPath}`);
  console.log("");
  console.log("All git repos will now enqueue jobs on push/pull.");
  console.log("Start the daemon with: ctx-hive serve");
}

export async function uninstallGitHooks(args: string[]): Promise<void> {
  const clean = args.includes("--clean");

  const currentPath = await getGlobalHooksPath();
  if (currentPath == null || currentPath === "") {
    console.log("No global core.hooksPath is set. Nothing to uninstall.");
    return;
  }

  if (currentPath !== GIT_HOOKS_DIR) {
    console.error(`core.hooksPath points to ${currentPath}, not ctx-hive.`);
    console.error("Not modifying — uninstall manually if needed.");
    process.exit(1);
  }

  // Unset core.hooksPath
  const proc = Bun.spawn(
    ["git", "config", "--global", "--unset", "core.hooksPath"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`Failed to unset core.hooksPath: ${stderr}`);
    process.exit(1);
  }

  console.log("Git hooks uninstalled (core.hooksPath unset).");

  if (clean) {
    await rm(GIT_HOOKS_DIR, { recursive: true, force: true });
    console.log(`Removed hooks directory: ${GIT_HOOKS_DIR}`);
  }
}

export async function checkGitHooksInstalled(): Promise<{
  installed: boolean;
  hooksPath: string | null;
  missing: GitHookName[];
}> {
  const hooksPath = await getGlobalHooksPath();
  if (hooksPath !== GIT_HOOKS_DIR) {
    const allHooks: GitHookName[] = ["pre-push", "post-merge", "post-rewrite"];
    return { installed: false, hooksPath, missing: allHooks };
  }

  const hookNames: GitHookName[] = ["pre-push", "post-merge", "post-rewrite"];
  const missing: GitHookName[] = [];
  for (const hookName of hookNames) {
    const hookFile = Bun.file(join(GIT_HOOKS_DIR, hookName));
    if (!(await hookFile.exists())) {
      missing.push(hookName);
    }
  }

  return { installed: missing.length === 0, hooksPath, missing };
}
