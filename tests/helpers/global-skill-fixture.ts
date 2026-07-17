import { dirname, join } from "node:path";

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
