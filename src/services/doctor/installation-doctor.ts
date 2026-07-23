import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { satisfies } from "semver";
import { readStoredProjectConfig } from "../../core/config/repository.js";
import type { ProjectConfig } from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import { isNodeError } from "../../core/node-errors.js";
import { checkGlobalSkill } from "../skill-management/global-skill.js";

export type InstallationStatus = "ready" | "not_ready" | "uninitialized";

export interface InstallationCheck {
  code:
    | "runtime.node"
    | "agent.global_skill"
    | "project.config"
    | "agent.project_skill"
    | "project.storage";
  status: "pass" | "fail" | "advisory" | "missing";
  message: string;
}

export interface ConfigureProjectRequiredAction {
  kind: "configure-project";
  blocking: true;
  reason: "project-config-missing";
}

export type DoctorRequiredAction = ConfigureProjectRequiredAction | null;

export interface InstallationDoctorResult {
  status: InstallationStatus;
  requiredAction: DoctorRequiredAction;
  checks: InstallationCheck[];
}

export interface InstallationDoctorInput {
  projectRoot: string;
  agentsHome: string;
  sourcePath: string;
}

const supportedNodeRange = "^22.0.0 || ^24.0.0";
const configPath = ".ai-qa/config.yaml";
const projectSkillPath = ".agents/skills/ai-qa-project/SKILL.md";
const projectSkillSegments = [
  ".agents",
  "skills",
  "ai-qa-project",
  "SKILL.md",
] as const;
const storageDirectories = [
  [".ai-qa", "cases"],
  [".ai-qa", "runs"],
  [".ai-qa", "run-groups"],
  [".ai-qa", "evidence"],
  [".ai-qa", "reports", "runs"],
  [".ai-qa", "reports", "groups"],
] as const;

export async function runInstallationDoctor(
  input: InstallationDoctorInput,
): Promise<InstallationDoctorResult> {
  const checks: InstallationCheck[] = [runtimeCheck()];
  checks.push(await globalSkillCheck(input));

  const storedConfig = await readConfig(input.projectRoot);
  if (storedConfig.state === "missing") {
    checks.push(
      {
        code: "project.config",
        status: "missing",
        message: `Configuration ${configPath} is missing`,
      },
      {
        code: "agent.project_skill",
        status: "missing",
        message: `Project Skill ${projectSkillPath} is missing`,
      },
      {
        code: "project.storage",
        status: "missing",
        message: "Canonical project storage is not initialized",
      },
    );
    return {
      status: "uninitialized",
      requiredAction: {
        kind: "configure-project",
        blocking: true,
        reason: "project-config-missing",
      },
      checks,
    };
  }

  if (storedConfig.state === "invalid") {
    checks.push(
      {
        code: "project.config",
        status: "fail",
        message: `Configuration ${configPath} is not a readable regular schema-v3 file`,
      },
      {
        code: "agent.project_skill",
        status: "missing",
        message: `Project Skill ${projectSkillPath} was not checked because the configuration is invalid`,
      },
      await storageCheck(input.projectRoot),
    );
    return { status: "not_ready", requiredAction: null, checks };
  }

  checks.push({
    code: "project.config",
    status: "pass",
    message: `Configuration ${configPath} is readable (schema v${storedConfig.config.schemaVersion})`,
  });
  checks.push(await projectSkillCheck(input.projectRoot));
  checks.push(await storageCheck(input.projectRoot));
  return {
    status: checks.some((check) => check.status === "fail")
      ? "not_ready"
      : "ready",
    requiredAction: null,
    checks,
  };
}

function runtimeCheck(): InstallationCheck {
  const version = process.versions.node;
  const supported = satisfies(version, supportedNodeRange);
  return {
    code: "runtime.node",
    status: supported ? "pass" : "fail",
    message: supported
      ? `Node ${version} is supported`
      : `Node ${version} does not satisfy ${supportedNodeRange}`,
  };
}

async function globalSkillCheck(
  input: InstallationDoctorInput,
): Promise<InstallationCheck> {
  try {
    const result = await checkGlobalSkill({
      agentsHome: input.agentsHome,
      sourcePath: input.sourcePath,
    });
    return {
      code: "agent.global_skill",
      status: result.status === "compatible" ? "pass" : "fail",
      message: `Global main Skill status: ${result.status}`,
    };
  } catch {
    return {
      code: "agent.global_skill",
      status: "fail",
      message: "Global main Skill status: conflict",
    };
  }
}

type ConfigInspection =
  | { state: "regular"; config: ProjectConfig }
  | { state: "missing" }
  | { state: "invalid" };

async function readConfig(projectRoot: string): Promise<ConfigInspection> {
  try {
    return {
      state: "regular",
      config: await readStoredProjectConfig(projectRoot),
    };
  } catch (error: unknown) {
    if (
      error instanceof AiQaError &&
      error.code === "storage.integrity_error" &&
      error.details.causeCode === "ENOENT"
    ) {
      return { state: "missing" };
    }
    return { state: "invalid" };
  }
}

async function projectSkillCheck(
  projectRoot: string,
): Promise<InstallationCheck> {
  const state = await inspectRegularFile(projectRoot, projectSkillSegments);
  if (state === "regular") {
    return {
      code: "agent.project_skill",
      status: "pass",
      message: `Project Skill ${projectSkillPath} is a regular file`,
    };
  }
  return {
    code: "agent.project_skill",
    status: "fail",
    message:
      state === "missing"
        ? `Project Skill ${projectSkillPath} is missing`
        : `Project Skill ${projectSkillPath} is not a project-local regular file`,
  };
}

async function storageCheck(projectRoot: string): Promise<InstallationCheck> {
  for (const segments of storageDirectories) {
    const relativePath = segments.join("/");
    if (!(await isReadableWritableDirectory(projectRoot, segments))) {
      return {
        code: "project.storage",
        status: "fail",
        message: `Canonical directory ${relativePath} is missing, unsafe, or not readable and writable`,
      };
    }
  }
  return {
    code: "project.storage",
    status: "pass",
    message: "Canonical project storage directories are readable and writable",
  };
}

async function inspectRegularFile(
  projectRoot: string,
  segments: readonly string[],
): Promise<"regular" | "missing" | "unsafe"> {
  try {
    const canonicalRoot = await realpath(projectRoot);
    let current = canonicalRoot;
    for (const segment of segments.slice(0, -1)) {
      current = resolve(current, segment);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error: unknown) {
        return isNodeError(error, "ENOENT") ? "missing" : "unsafe";
      }
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (await realpath(current)) !== current
      ) {
        return "unsafe";
      }
    }
    const path = resolve(current, segments.at(-1)!);
    let stats;
    try {
      stats = await lstat(path);
    } catch (error: unknown) {
      return isNodeError(error, "ENOENT") ? "missing" : "unsafe";
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      (await realpath(path)) !== path
    ) {
      return "unsafe";
    }
    return "regular";
  } catch {
    return "unsafe";
  }
}

async function isReadableWritableDirectory(
  projectRoot: string,
  segments: readonly string[],
): Promise<boolean> {
  try {
    const canonicalRoot = await realpath(projectRoot);
    let current = canonicalRoot;
    for (const segment of segments) {
      current = resolve(current, segment);
      const stats = await lstat(current);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (await realpath(current)) !== current
      ) {
        return false;
      }
    }
    await access(current, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
