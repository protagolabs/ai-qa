import { createHash } from "node:crypto";
import { AiQaError } from "../../core/errors.js";
import { inspectOptionalProjectLocalRegularFile } from "../../core/fs/project-storage.js";
import type { ProjectSkillSnapshot } from "../../core/runs/schema.js";

const PROJECT_SKILL_PATH = ".agents/skills/ai-qa-project/SKILL.md" as const;
const PROJECT_SKILL_SEGMENTS = [
  ".agents",
  "skills",
  "ai-qa-project",
  "SKILL.md",
] as const;

function integrityError(): AiQaError {
  return new AiQaError(
    "project_skill.integrity_error",
    "Project Skill must be a stable project-local regular file",
    { path: PROJECT_SKILL_PATH },
  );
}

export async function readProjectSkillSnapshot(
  projectRoot: string,
): Promise<ProjectSkillSnapshot> {
  try {
    const inspected = await inspectOptionalProjectLocalRegularFile(
      projectRoot,
      PROJECT_SKILL_SEGMENTS,
    );
    if (inspected.state !== "regular" || inspected.content === undefined) {
      throw integrityError();
    }
    return {
      path: PROJECT_SKILL_PATH,
      contentSha256: createHash("sha256")
        .update(inspected.content, "utf8")
        .digest("hex"),
    };
  } catch {
    throw integrityError();
  }
}

export async function assertCurrentProjectSkillSnapshot(input: {
  projectRoot: string;
  snapshot: ProjectSkillSnapshot;
}): Promise<void> {
  const current = await readProjectSkillSnapshot(input.projectRoot);
  if (current.contentSha256 !== input.snapshot.contentSha256) {
    throw new AiQaError(
      "project_skill.changed",
      "Project Skill changed after the run started",
      { path: PROJECT_SKILL_PATH },
    );
  }
}
