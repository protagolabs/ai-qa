import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeManagedSkill } from "../../src/services/skill-management/managed-skill.js";

export async function installStaleGlobalSkill(
  agentsHome: string,
): Promise<void> {
  const destination = join(agentsHome, "skills", "ai-qa", "SKILL.md");
  const source = await readFile(
    fileURLToPath(new URL("../../src/skills/global/SKILL.md", import.meta.url)),
    "utf8",
  );
  const staleSource = source.replace(
    "  aiQaSkillVersion: 2.0.0",
    "  aiQaSkillVersion: 1.0.0",
  );
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(
    destination,
    mergeManagedSkill({
      source: staleSource,
      confirmManagedReplacement: false,
    }).content,
  );
}

export function installedGlobalSkillReference(
  agentsHome: string,
  relativePath = "shared-work-protocol.md",
): string {
  return join(
    dirname(join(agentsHome, "skills", "ai-qa", "SKILL.md")),
    "references",
    relativePath,
  );
}
