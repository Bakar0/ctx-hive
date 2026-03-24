import { z } from "zod";
import { ensureJobDirs } from "../daemon/jobs.ts";
import { CLAUDE_SETTINGS_PATH } from "../adapter/claude-paths.ts";

const HookCommandSchema = z.object({ type: z.string().optional(), command: z.string().optional() });
const HookEntrySchema = z.object({ matcher: z.string().optional(), hooks: z.array(HookCommandSchema).optional() });
const SettingsSchema = z.object({
  hooks: z.record(z.string(), z.array(HookEntrySchema)).optional(),
}).passthrough();

interface HookDef {
  event: string;
  command: string;
  label: string;
}

const HOOKS: HookDef[] = [
  {
    event: "SessionEnd",
    command: "ctx-hive enqueue session-mine",
    label: "SessionEnd (session mining)",
  },
  {
    event: "UserPromptSubmit",
    command: "ctx-hive inject",
    label: "UserPromptSubmit (context injection)",
  },
];

/** Check if a hook entry belongs to ctx-hive (command starts with "ctx-hive") */
function isCtxHiveHook(entry: z.infer<typeof HookEntrySchema>): boolean {
  return entry.hooks?.some((h) => h.command?.startsWith("ctx-hive") === true) === true;
}

export async function installHook(): Promise<void> {
  // 1. Ensure job directories exist
  ensureJobDirs();

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

  // 3. Remove existing ctx-hive hooks, then add current definitions
  const hooks = settings.hooks ?? {};

  for (const def of HOOKS) {
    // Remove any existing ctx-hive hooks for this event
    const existing = hooks[def.event] ?? [];
    const filtered = existing.filter((entry) => !isCtxHiveHook(entry));

    // Add current definition
    filtered.push({
      matcher: "",
      hooks: [{ type: "command", command: def.command }],
    });
    hooks[def.event] = filtered;
    console.log(`${def.label} hook installed.`);
  }

  settings.hooks = hooks;

  // 4. Write back
  await Bun.write(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log(`\nSettings: ${CLAUDE_SETTINGS_PATH}`);
  console.log("Start the daemon with: ctx-hive serve");
}
