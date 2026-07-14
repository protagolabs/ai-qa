import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  projectConfigSchema,
  type ProjectConfig,
} from "../../core/config/schema.js";
import { createProjectConfig } from "../../core/config/repository.js";
import { AiQaError } from "../../core/errors.js";
import { ensureProjectLocalDirectory } from "../../core/fs/project-storage.js";
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
  const aiQaRoot = await ensureProjectLocalDirectory(input.projectRoot, [
    ".ai-qa",
  ]);
  const release = await lockfile.lock(aiQaRoot, {
    realpath: false,
    retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    try {
      await lstat(resolve(aiQaRoot, "config.yaml"));
      throw new AiQaError(
        "project.already_initialized",
        "Project already has an AI QA configuration",
        { projectRoot: identity.canonicalPath },
      );
    } catch (error: unknown) {
      if (error instanceof AiQaError) throw error;
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    for (const segments of [
      [".ai-qa", "cases"],
      [".ai-qa", "runs"],
      [".ai-qa", "evidence"],
      [".ai-qa", "reports", "runs"],
    ] as const) {
      await ensureProjectLocalDirectory(input.projectRoot, segments);
    }
    await createProjectConfig(input.projectRoot, config);
  } finally {
    await release();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
