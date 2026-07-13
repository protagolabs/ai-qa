import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { projectConfigSchema, type ProjectConfig } from "./schema.js";

export async function readProjectConfig(
  projectRoot: string,
): Promise<ProjectConfig> {
  const value: unknown = parse(
    await readFile(join(projectRoot, ".ai-qa", "config.yaml"), "utf8"),
  );
  return projectConfigSchema.parse(value);
}

export async function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  const validated = projectConfigSchema.parse(config);
  await atomicWriteFile(
    join(projectRoot, ".ai-qa", "config.yaml"),
    stringify(validated, { sortMapEntries: true }),
  );
}
