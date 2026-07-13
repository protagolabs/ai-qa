import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  projectConfigSchema,
  type ProjectConfig,
} from "../../core/config/schema.js";
import { writeProjectConfig } from "../../core/config/repository.js";
import { AiQaError } from "../../core/errors.js";
import { readRepositoryIdentity } from "../trust/repository-identity.js";
import { TrustStore } from "../trust/trust-store.js";

export interface InitializeProjectInput {
  projectRoot: string;
  aiQaHome: string;
  config: ProjectConfig;
}

export async function initializeProject(
  input: InitializeProjectInput,
): Promise<void> {
  const config = projectConfigSchema.parse(input.config);
  const identity = await readRepositoryIdentity(input.projectRoot);
  if (!(await new TrustStore(input.aiQaHome).isTrusted(identity))) {
    throw new AiQaError(
      "trust.not_trusted",
      "Confirm repository trust before initialization",
    );
  }
  await Promise.all(
    ["cases", "runs", "evidence", "reports/runs"].map((directory) =>
      mkdir(join(input.projectRoot, ".ai-qa", directory), {
        recursive: true,
      }),
    ),
  );
  await writeProjectConfig(input.projectRoot, config);
}
