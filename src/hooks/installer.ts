import { join } from "node:path";
import { homedir } from "node:os";
import { ensureJobDirs } from "../daemon/jobs.ts";

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

const HOOK_ENTRY = {
  matcher: "",
  hooks: [
    {
      type: "command",
      command: "ctx-hive enqueue session-mine",
    },
  ],
};

export async function installHook(): Promise<void> {
  // 1. Ensure job directories exist
  await ensureJobDirs();

  // 2. Read existing settings (or start fresh)
  const settingsFile = Bun.file(CLAUDE_SETTINGS_PATH);
  let settings: Record<string, unknown> = {};
  if (await settingsFile.exists()) {
    try {
      const raw: unknown = await settingsFile.json();
      // oxlint-disable-next-line no-unsafe-type-assertion -- settings.json schema
      settings = raw as Record<string, unknown>;
    } catch {
      console.error(`Warning: could not parse ${CLAUDE_SETTINGS_PATH}, creating backup`);
      const backup = `${CLAUDE_SETTINGS_PATH}.bak.${Date.now()}`;
      await Bun.write(backup, await settingsFile.text());
      console.error(`Backup saved to ${backup}`);
    }
  }

  // 3. Merge hook into settings
  const rawHooks: unknown = settings.hooks ?? {};
  // oxlint-disable-next-line no-unsafe-type-assertion -- settings hooks schema
  const hooks = rawHooks as Record<string, unknown[]>;
  const rawSessionEnd: unknown = hooks.SessionEnd ?? [];
  // oxlint-disable-next-line no-unsafe-type-assertion -- settings hooks schema
  const sessionEndHooks = rawSessionEnd as Array<{ hooks?: Array<{ command?: string }> }>;

  // Check if already installed
  const alreadyInstalled = sessionEndHooks.some((entry) =>
    entry.hooks?.some((h) => h.command === "ctx-hive enqueue session-mine") === true,
  );

  if (alreadyInstalled) {
    console.log("SessionEnd hook is already installed.");
    return;
  }

  sessionEndHooks.push(HOOK_ENTRY);
  hooks.SessionEnd = sessionEndHooks;
  settings.hooks = hooks;

  // 4. Write back
  await Bun.write(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log("SessionEnd hook installed successfully.");
  console.log(`  Settings: ${CLAUDE_SETTINGS_PATH}`);
  console.log(`  Command:  ctx-hive enqueue session-mine`);
  console.log("");
  console.log("Start the daemon with: ctx-hive serve");
}
