#!/usr/bin/env bun
import { ctx } from "./ctx/commands.ts";
import { installSkills, checkSkillsInstalled } from "./utils/skill-installer.ts";

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

// Delegate everything else to ctx command dispatcher
await ctx(args);
process.exit(0);
