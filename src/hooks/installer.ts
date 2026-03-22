import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { ensureJobDirs } from "../daemon/jobs.ts";

const HookCommandSchema = z.object({ command: z.string().optional() });
const HookEntrySchema = z.object({ hooks: z.array(HookCommandSchema).optional() });
const SettingsSchema = z.object({
  hooks: z.record(z.string(), z.array(HookEntrySchema)).optional(),
}).passthrough();

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
  let settings: z.infer<typeof SettingsSchema> = {};
  if (await settingsFile.exists()) {
    try {
      settings = SettingsSchema.parse(await settingsFile.json());
    } catch {
      console.error(`Warning: could not parse ${CLAUDE_SETTINGS_PATH}, creating backup`);
      const backup = `${CLAUDE_SETTINGS_PATH}.bak.${Date.now()}`;
      await Bun.write(backup, await settingsFile.text());
      console.error(`Backup saved to ${backup}`);
    }
  }

  // 3. Merge hook into settings
  const hooks = settings.hooks ?? {};
  const sessionEndHooks = hooks.SessionEnd ?? [];

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
