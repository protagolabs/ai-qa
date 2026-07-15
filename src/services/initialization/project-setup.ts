import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import lockfile from "proper-lockfile";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { sha256Canonical } from "../../core/canonical-json.js";
import {
  normalizeProjectConfig,
  projectConfigV2Schema,
  storedProjectConfigSchema,
  type ProjectConfigV2,
} from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import {
  ensureProjectLocalDirectory,
  inspectOptionalProjectLocalRegularFile,
  type OptionalProjectLocalFile,
} from "../../core/fs/project-storage.js";
import {
  prepareProjectSkill,
  projectSkillRequestSchema,
} from "../skill-management/project-skill.js";
import { readRepositoryIdentity } from "../trust/repository-identity.js";
import {
  applyProjectFileTransaction,
  type ProjectFileTransactionHooks,
  type ProjectFileWrite,
} from "./project-file-transaction.js";

const configSegments = [".ai-qa", "config.yaml"] as const;
const projectSkillSegments = [
  ".agents",
  "skills",
  "ai-qa-project",
  "SKILL.md",
] as const;
const configRelativePath = ".ai-qa/config.yaml" as const;
const projectSkillRelativePath =
  ".agents/skills/ai-qa-project/SKILL.md" as const;
const targetPaths = [configRelativePath, projectSkillRelativePath] as const;

export const initializationRequestSchema = z.object({
  config: projectConfigV2Schema,
  projectSkill: projectSkillRequestSchema,
});

export interface InitializationRequest {
  config: ProjectConfigV2;
  projectSkill: z.infer<typeof projectSkillRequestSchema>;
}

export type ProjectSetupOperation =
  "init" | "configure" | "skill-generate" | "skill-sync";

export interface DestinationSnapshot {
  relativePath: string;
  state: "missing" | "regular";
  identity?: {
    device: string;
    inode: string;
    size: string;
    modifiedNanoseconds: string;
  };
  contentSha256?: string;
}

export interface ProjectSetupPreview {
  schemaVersion: 1;
  operation: ProjectSetupOperation;
  projectRoot: string;
  configPath: typeof configRelativePath;
  projectSkillPath: typeof projectSkillRelativePath;
  writePaths: (typeof configRelativePath | typeof projectSkillRelativePath)[];
  config: ProjectConfigV2;
  projectSkill: {
    reason: string;
    content: string;
    requiresManagedReplacement: boolean;
  };
  destinations: DestinationSnapshot[];
  unifiedDiff: string;
  checksum: string;
}

export interface PreviewProjectSetupInput {
  operation: ProjectSetupOperation;
  projectRoot: string;
  request: InitializationRequest;
}

export interface ApplyProjectSetupInput extends PreviewProjectSetupInput {
  confirmChecksum: string;
  hooks?: ProjectFileTransactionHooks;
}

interface InspectedSetup {
  operation: ProjectSetupOperation;
  request: InitializationRequest;
  effectiveRequest: InitializationRequest;
  projectRoot: string;
  configFile: OptionalProjectLocalFile;
  projectSkillFile: OptionalProjectLocalFile;
  destinations: DestinationSnapshot[];
  checksum: string;
}

export async function previewProjectSetup(
  input: PreviewProjectSetupInput,
): Promise<ProjectSetupPreview> {
  const inspected = await inspectSetup(input);
  assertOperationState(inspected);
  return materializePreview(inspected);
}

export async function applyProjectSetup(
  input: ApplyProjectSetupInput,
): Promise<ProjectSetupPreview> {
  const parsedRequest = initializationRequestSchema.parse(input.request);
  const aiQaRoot = await ensureProjectLocalDirectory(input.projectRoot, [
    ".ai-qa",
  ]);
  const release = await lockfile.lock(aiQaRoot, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: {
      forever: true,
      factor: 2,
      minTimeout: 10,
      maxTimeout: 100,
      randomize: false,
    },
  });
  try {
    let inspected: InspectedSetup;
    try {
      inspected = await inspectSetup({ ...input, request: parsedRequest });
    } catch (error: unknown) {
      if (
        error instanceof AiQaError &&
        error.code === "storage.integrity_error"
      ) {
        throw error;
      }
      if (
        error instanceof z.ZodError ||
        (error instanceof AiQaError &&
          error.code === "project.not_initialized") ||
        (error instanceof Error && error.name === "YAMLParseError")
      ) {
        throw checksumMismatch(input.confirmChecksum);
      }
      throw error;
    }
    if (inspected.checksum !== input.confirmChecksum) {
      throw checksumMismatch(input.confirmChecksum, inspected.checksum);
    }
    assertOperationState(inspected);
    const preview = materializePreview(inspected);
    if (input.operation === "init") {
      for (const segments of [
        [".ai-qa", "cases"],
        [".ai-qa", "runs"],
        [".ai-qa", "evidence"],
        [".ai-qa", "reports", "runs"],
      ] as const) {
        await ensureProjectLocalDirectory(input.projectRoot, segments);
      }
    }
    await applyProjectFileTransaction({
      projectRoot: inspected.projectRoot,
      writes: setupWrites(preview),
      readSet: preview.destinations,
      ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    });
    return preview;
  } finally {
    await release();
  }
}

async function inspectSetup(
  input: PreviewProjectSetupInput,
): Promise<InspectedSetup> {
  const request = initializationRequestSchema.parse(input.request);
  const identity = await readRepositoryIdentity(input.projectRoot);
  const [configFile, projectSkillFile] = await Promise.all([
    inspectOptionalProjectLocalRegularFile(
      identity.canonicalPath,
      configSegments,
    ),
    inspectOptionalProjectLocalRegularFile(
      identity.canonicalPath,
      projectSkillSegments,
    ),
  ]);
  const config = effectiveConfig(input.operation, request.config, configFile);
  const effectiveRequest: InitializationRequest = {
    config,
    projectSkill: request.projectSkill,
  };
  const destinations = [
    destinationSnapshot(configRelativePath, configFile),
    destinationSnapshot(projectSkillRelativePath, projectSkillFile),
  ];
  const checksum = sha256Canonical({
    schemaVersion: 1,
    operation: input.operation,
    repository: {
      canonicalPath: identity.canonicalPath,
      fingerprint: identity.fingerprint,
    },
    request: effectiveRequest,
    targetPaths: [configRelativePath, projectSkillRelativePath],
    destinations,
  });
  return {
    operation: input.operation,
    request,
    effectiveRequest,
    projectRoot: identity.canonicalPath,
    configFile,
    projectSkillFile,
    destinations,
    checksum,
  };
}

function effectiveConfig(
  operation: ProjectSetupOperation,
  submitted: ProjectConfigV2,
  installed: OptionalProjectLocalFile,
): ProjectConfigV2 {
  if (operation === "init") return submitted;
  if (installed.state === "missing") {
    throw new AiQaError(
      "project.not_initialized",
      "Project does not have an AI QA configuration",
    );
  }
  const current = normalizeProjectConfig(
    storedProjectConfigSchema.parse(parse(installed.content!)),
  );
  if (operation === "configure") {
    return projectConfigV2Schema.parse({
      ...submitted,
      project: { ...submitted.project, id: current.project.id },
    });
  }
  return current;
}

function destinationSnapshot(
  relativePath: string,
  file: OptionalProjectLocalFile,
): DestinationSnapshot {
  if (file.state === "missing") return { relativePath, state: "missing" };
  return {
    relativePath,
    state: "regular",
    identity: {
      device: file.stats!.dev.toString(),
      inode: file.stats!.ino.toString(),
      size: file.stats!.size.toString(),
      modifiedNanoseconds: file.stats!.mtimeNs.toString(),
    },
    contentSha256: `sha256:${createHash("sha256")
      .update(file.content!)
      .digest("hex")}`,
  };
}

function assertOperationState(input: InspectedSetup): void {
  if (input.operation === "init" && input.configFile.state === "regular") {
    throw new AiQaError(
      "project.already_initialized",
      "Project already has an AI QA configuration",
      { projectRoot: input.projectRoot },
    );
  }
  if (input.operation === "configure" && input.configFile.state === "missing") {
    throw new AiQaError(
      "project.not_initialized",
      "Project does not have an AI QA configuration",
      { projectRoot: input.projectRoot },
    );
  }
  if (
    input.operation === "skill-generate" &&
    input.projectSkillFile.state === "regular"
  ) {
    throw new AiQaError(
      "skill.already_installed",
      "Project Skill already exists",
      { projectRoot: input.projectRoot },
    );
  }
  if (
    input.operation === "skill-sync" &&
    input.projectSkillFile.state === "missing"
  ) {
    throw new AiQaError("skill.not_installed", "Project Skill does not exist", {
      projectRoot: input.projectRoot,
    });
  }
}

function materializePreview(input: InspectedSetup): ProjectSetupPreview {
  const proposedConfig = stringify(input.effectiveRequest.config, {
    sortMapEntries: true,
  });
  const preparedSkill = prepareProjectSkill({
    source: input.effectiveRequest.projectSkill.content,
    ...(input.projectSkillFile.content === undefined
      ? {}
      : { existing: input.projectSkillFile.content }),
    secretReferences: input.effectiveRequest.config.secretReferences,
  });
  const configDiff =
    (input.operation === "init" || input.operation === "configure") &&
    input.configFile.content !== undefined &&
    input.configFile.content !== proposedConfig
      ? createTwoFilesPatch(
          configRelativePath,
          `${configRelativePath} (proposed)`,
          input.configFile.content,
          proposedConfig,
        )
      : "";
  const projectSkillDiff =
    input.projectSkillFile.content === undefined
      ? ""
      : preparedSkill.unifiedDiff;
  return {
    schemaVersion: 1,
    operation: input.operation,
    projectRoot: input.projectRoot,
    configPath: configRelativePath,
    projectSkillPath: projectSkillRelativePath,
    writePaths: writePaths(input.operation),
    config: input.effectiveRequest.config,
    projectSkill: {
      reason: input.effectiveRequest.projectSkill.reason,
      content: preparedSkill.content,
      requiresManagedReplacement: preparedSkill.requiresManagedReplacement,
    },
    destinations: input.destinations,
    unifiedDiff: [configDiff, projectSkillDiff]
      .filter((value) => value.length > 0)
      .join("\n"),
    checksum: input.checksum,
  };
}

function writePaths(
  operation: ProjectSetupOperation,
): (typeof configRelativePath | typeof projectSkillRelativePath)[] {
  return operation === "init" || operation === "configure"
    ? [...targetPaths]
    : [projectSkillRelativePath];
}

function setupWrites(preview: ProjectSetupPreview): ProjectFileWrite[] {
  const writes: ProjectFileWrite[] = [];
  for (const path of preview.writePaths) {
    if (path === configRelativePath) {
      writes.push({
        relativeSegments: configSegments,
        content: stringify(preview.config, { sortMapEntries: true }),
      });
    } else {
      writes.push({
        relativeSegments: projectSkillSegments,
        content: preview.projectSkill.content,
      });
    }
  }
  return writes;
}

function checksumMismatch(confirmed: string, current?: string): AiQaError {
  return new AiQaError(
    "setup.checksum_mismatch",
    "Project setup changed after preview; preview the complete request again",
    {
      confirmed,
      ...(current === undefined ? {} : { current }),
    },
  );
}
