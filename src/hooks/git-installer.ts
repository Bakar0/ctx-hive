import { join, resolve } from "node:path";
import { mkdir, chmod, rm } from "node:fs/promises";
import { hiveRoot } from "../ctx/store.ts";
import { ensureJobDirs } from "../daemon/jobs.ts";
import { loadTrackedRepos } from "../repo/tracking.ts";
import {
  HOOK_SCRIPTS,
  HOOK_NAMES,
  REPO_LOCAL_SCRIPTS,
  CTX_HIVE_MARKER_START,
  CTX_HIVE_MARKER_END,
  embedBinaryPath,
  type GitHookName,
} from "./git-scripts.ts";

const GIT_HOOKS_DIR = join(hiveRoot(), "git-hooks");

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
  const argv0 = process.argv[0] ?? "";
  const basename = argv0.split("/").pop() ?? "";

  // 1. Already running as compiled ctx-hive binary
  if (basename === "ctx-hive") return argv0;

  // 2. Check deployed binary at ~/.local/bin/ctx-hive
  const deployedBin = join(process.env["HOME"] ?? "", ".local", "bin", "ctx-hive");
  if (await Bun.file(deployedBin).exists()) return deployedBin;

  // 3. Check if ctx-hive is in PATH
  try {
    const proc = Bun.spawn(["which", "ctx-hive"], { stdout: "pipe", stderr: "pipe" });
    const path = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) === 0 && path) return path;
  } catch { /* ignore */ }

  // 4. Dev fallback: bun run <entry-point>
  const entryPoint = process.argv[1];
  if (argv0 !== "" && entryPoint != null && entryPoint !== "") return `${argv0} run ${entryPoint}`;

  return "ctx-hive";
}

export async function installGitHooks(args: string[]): Promise<void> {
  const force = args.includes("--force");

  // 1. Ensure job directories exist
  ensureJobDirs();

  // 2. Check existing core.hooksPath
  const currentPath = await getGlobalHooksPath();
  if (currentPath === GIT_HOOKS_DIR && !force) {
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

  // Patch repos that have local core.hooksPath overrides (e.g. husky)
  await patchAllTrackedRepoHooks();

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
  const hookNames = HOOK_NAMES;
  if (hooksPath !== GIT_HOOKS_DIR) {
    return { installed: false, hooksPath, missing: hookNames };
  }

  const missing: GitHookName[] = [];
  for (const hookName of hookNames) {
    const hookFile = Bun.file(join(GIT_HOOKS_DIR, hookName));
    if (!(await hookFile.exists())) {
      missing.push(hookName);
    }
  }

  return { installed: missing.length === 0, hooksPath, missing };
}

// ── Repo-local hook patching (for repos with local core.hooksPath, e.g. husky) ──

async function getLocalHooksPath(repoPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "config", "--local", "core.hooksPath"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the directory where user hook scripts should be placed.
 * For husky (core.hooksPath = ".husky/_"), user scripts go in ".husky/".
 * For other setups, scripts go directly in the hooks path.
 */
function resolveUserHooksDir(repoPath: string, localHooksPath: string): string {
  const abs = resolve(repoPath, localHooksPath);
  // Husky convention: core.hooksPath ends with "/_"
  if (localHooksPath.endsWith("/_")) return resolve(abs, "..");
  return abs;
}

/**
 * Extract ctx-hive block content from an existing script, if present.
 */
function hasCtxHiveBlock(content: string): boolean {
  return content.includes(CTX_HIVE_MARKER_START);
}

/**
 * Extract the ctx-hive enqueue lines (between markers) from a template,
 * suitable for appending to an existing script (no shebang).
 */
function extractBlock(template: string): string {
  const start = template.indexOf(CTX_HIVE_MARKER_START);
  const end = template.indexOf(CTX_HIVE_MARKER_END);
  if (start === -1 || end === -1) return "";
  return template.slice(start, end + CTX_HIVE_MARKER_END.length);
}

/**
 * Patch a single repo's local hooks to include ctx-hive enqueue calls.
 * Only acts if the repo has a local core.hooksPath override.
 */
export async function patchRepoHooks(repoPath: string): Promise<boolean> {
  const localPath = await getLocalHooksPath(repoPath);
  if (localPath == null) return false;

  const userDir = resolveUserHooksDir(repoPath, localPath);
  await mkdir(userDir, { recursive: true });

  let patched = 0;
  for (const hookName of HOOK_NAMES) {
    const hookFile = join(userDir, hookName);
    const file = Bun.file(hookFile);
    const exists = await file.exists();

    if (exists) {
      const content = await file.text();
      if (hasCtxHiveBlock(content)) continue; // already patched
      // Append ctx-hive block to existing script
      const block = extractBlock(REPO_LOCAL_SCRIPTS[hookName]);
      await Bun.write(hookFile, content.trimEnd() + "\n\n" + block + "\n");
    } else {
      // Create new script with ctx-hive enqueue
      await Bun.write(hookFile, REPO_LOCAL_SCRIPTS[hookName]);
    }
    await chmod(hookFile, 0o755);
    patched++;
  }

  return patched > 0;
}

/**
 * Patch all tracked repos that have local core.hooksPath overrides.
 */
export async function patchAllTrackedRepoHooks(): Promise<void> {
  const repos = loadTrackedRepos();
  for (const repo of repos) {
    const patched = await patchRepoHooks(repo.absPath);
    if (patched) {
      console.log(`  Patched repo-local hooks: ${repo.name} (${repo.absPath})`);
    }
  }
}
