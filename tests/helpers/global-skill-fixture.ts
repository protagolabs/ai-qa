import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mergeManagedSkill } from "../../src/services/skill-management/managed-skill.js";

export const releasedLegacyGlobalSkillDirectory = join(
  process.cwd(),
  "src",
  "skills",
  "global",
  "legacy",
  "1.0.0",
);

export async function copyReleasedLegacyGlobalSkill(
  currentSourceDirectory: string,
): Promise<void> {
  await cp(
    releasedLegacyGlobalSkillDirectory,
    join(currentSourceDirectory, "legacy", "1.0.0"),
    { recursive: true },
  );
}

export async function installReleasedLegacyGlobalSkill(
  agentsHome: string,
): Promise<void> {
  const destinationDirectory = join(agentsHome, "skills", "ai-qa");
  const source = await readFile(
    join(releasedLegacyGlobalSkillDirectory, "SKILL.md"),
    "utf8",
  );
  await mkdir(destinationDirectory, { recursive: true });
  await writeFile(
    join(destinationDirectory, "SKILL.md"),
    mergeManagedSkill({
      source,
      confirmManagedReplacement: false,
    }).content,
  );
  await cp(
    join(releasedLegacyGlobalSkillDirectory, "references"),
    join(destinationDirectory, "references"),
    { recursive: true },
  );
}

export async function readReleasedLegacyGlobalSkill(): Promise<string> {
  return readFile(join(releasedLegacyGlobalSkillDirectory, "SKILL.md"), "utf8");
}

export function installedGlobalSkillReference(agentsHome: string): string {
  return join(
    dirname(join(agentsHome, "skills", "ai-qa", "SKILL.md")),
    "references",
    "web-work-protocol.md",
  );
}
