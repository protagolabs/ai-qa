import { randomUUID } from "node:crypto";
import { link, open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { AiQaError } from "../errors.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import {
  requireProjectLocalDirectory,
  requireProjectLocalRegularFile,
} from "../fs/project-storage.js";
import { isNodeError } from "../node-errors.js";
import { projectConfigSchema, type ProjectConfig } from "./schema.js";

function serialize(config: ProjectConfig): string {
  return stringify(projectConfigSchema.parse(config), {
    sortMapEntries: true,
  });
}

export async function createProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  const directory = await requireProjectLocalDirectory(projectRoot, [".ai-qa"]);
  const path = resolve(directory, "config.yaml");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  let closed = false;
  let ownsTemporary = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    ownsTemporary = true;
    await handle.writeFile(serialize(config), "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    try {
      await link(temporaryPath, path);
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) {
        throw new AiQaError(
          "project.already_initialized",
          "Project already has an AI QA configuration",
          { projectRoot: resolve(directory, "..") },
        );
      }
      throw error;
    }
  } catch (error: unknown) {
    if (!closed) {
      try {
        await handle?.close();
      } catch {
        // Preserve the original create failure.
      }
    }
    if (ownsTemporary) {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // Preserve the original create failure.
      }
    }
    throw error;
  }
  try {
    await rm(temporaryPath, { force: true });
  } catch {
    // The configuration was already published successfully.
  }
}

export async function readProjectConfig(
  projectRoot: string,
): Promise<ProjectConfig> {
  return readStoredProjectConfig(projectRoot);
}

export async function readStoredProjectConfig(
  projectRoot: string,
): Promise<ProjectConfig> {
  const path = await requireProjectLocalRegularFile(projectRoot, [
    ".ai-qa",
    "config.yaml",
  ]);
  return projectConfigSchema.parse(parse(await readFile(path, "utf8")));
}

export async function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  const path = await requireProjectLocalRegularFile(projectRoot, [
    ".ai-qa",
    "config.yaml",
  ]);
  await atomicWriteFile(path, serialize(config));
}
