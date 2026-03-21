#!/usr/bin/env bun
import { ctx } from "./ctx/commands.ts";
import { installSkills, checkSkillsInstalled } from "./skills/installer.ts";
import { serve } from "./daemon/serve.ts";
import { enqueue } from "./hooks/enqueue.ts";
import { installHook } from "./hooks/installer.ts";
import { installGitHooks, uninstallGitHooks } from "./hooks/git-installer.ts";

const { version } = await import("../package.json");
const args = process.argv.slice(2);
const command = args[0];

if (command === "--version" || command === "-v") {
  console.log(version);
  process.exit(0);
}

if (command === "install-skill") {
  await installSkills();
  const { installed, missing } = await checkSkillsInstalled();
  if (installed) console.log("Skill verified.");
  else { console.error("Missing:", missing); process.exit(1); }
  process.exit(0);
}

if (command === "install-hook") {
  await installHook();
  process.exit(0);
}

if (command === "install-git-hooks") {
  await installGitHooks(args.slice(1));
  process.exit(0);
}

if (command === "uninstall-git-hooks") {
  await uninstallGitHooks(args.slice(1));
  process.exit(0);
}

if (command === "enqueue") {
  await enqueue(args.slice(1));
  process.exit(0);
}

if (command === "serve") {
  await serve(args.slice(1));
  // serve is long-running, no process.exit here
} else {
  // Delegate everything else to ctx command dispatcher
  await ctx(args);
  process.exit(0);
}
