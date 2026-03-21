import { access, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { SKILL_ASSETS } from "./assets";

const SKILLS_TARGET_DIR = resolve(homedir(), ".claude", "skills");

const REQUIRED_SKILLS = Object.keys(SKILL_ASSETS);

export async function installSkills(): Promise<void> {
  for (const [skill, files] of Object.entries(SKILL_ASSETS)) {
    for (const [filePath, content] of Object.entries(files)) {
      const dest = join(SKILLS_TARGET_DIR, skill, filePath);
      await mkdir(dirname(dest), { recursive: true });
      await Bun.write(dest, content);
    }
  }
  console.log(`Installed ${REQUIRED_SKILLS.length} skills to ${SKILLS_TARGET_DIR}`);
}

export async function checkSkillsInstalled(): Promise<{ installed: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const skill of REQUIRED_SKILLS) {
    const skillPath = join(SKILLS_TARGET_DIR, skill, "SKILL.md");
    try {
      await access(skillPath);
    } catch {
      missing.push(skill);
    }
  }
  return { installed: missing.length === 0, missing };
}

// Allow running directly: bun run src/utils/skill-installer.ts
if (import.meta.main) {
  await installSkills();
  const { installed, missing } = await checkSkillsInstalled();
  if (installed) {
    console.log("All skills verified.");
  } else {
    console.error("Missing skills:", missing);
    process.exit(1);
  }
}
