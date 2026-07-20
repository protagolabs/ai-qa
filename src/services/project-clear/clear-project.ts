import { realpath } from "node:fs/promises";
import {
  prepareProjectLocalRemoval,
  type PreparedProjectLocalRemoval,
} from "../../core/fs/project-storage.js";

interface ClearProjectInput {
  projectRoot: string;
  records: boolean;
}

export interface ClearProjectResult {
  status: "cleared";
  projectRoot: string;
  records: boolean;
  removedPaths: string[];
}

interface TargetSpec {
  segments: readonly string[];
  expected: "file" | "directory";
}

const projectSkillTarget: TargetSpec = {
  segments: [".agents", "skills", "ai-qa-project"],
  expected: "directory",
};

export async function clearProject(
  input: ClearProjectInput,
): Promise<ClearProjectResult> {
  const projectRoot = await realpath(input.projectRoot);
  const targets: readonly TargetSpec[] = [
    input.records
      ? { segments: [".ai-qa"], expected: "directory" }
      : { segments: [".ai-qa", "config.yaml"], expected: "file" },
    projectSkillTarget,
  ];
  const prepared: PreparedProjectLocalRemoval[] = await Promise.all(
    targets.map((target) =>
      prepareProjectLocalRemoval({ projectRoot, ...target }),
    ),
  );
  const removedPaths: string[] = [];
  for (const target of prepared) {
    if (await target.remove()) removedPaths.push(target.relativePath);
  }
  return {
    status: "cleared",
    projectRoot,
    records: input.records,
    removedPaths,
  };
}
