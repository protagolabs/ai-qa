import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import { readProjectConfig } from "../../core/config/repository.js";
import { AiQaError } from "../../core/errors.js";
import { inspectOptionalProjectLocalRegularFile } from "../../core/fs/project-storage.js";
import {
  applyProjectSetup,
  previewProjectSetup,
} from "../../services/initialization/initialize-project.js";
import type {
  ProjectSetupOperation,
  ProjectSetupPreview,
} from "../../services/initialization/project-setup.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import {
  checkGlobalSkill,
  previewGlobalSkillSync,
  syncGlobalSkill,
} from "../../services/skill-management/global-skill.js";
import {
  inspectProjectSkill,
  projectSkillRequestSchema,
} from "../../services/skill-management/project-skill.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

interface MutatingGlobalSkillOptions {
  global: boolean;
  confirmManagedReplacement?: boolean;
}

interface PreviewConfirmationOptions {
  stdinJson: boolean;
  preview?: boolean;
  confirmChecksum?: string;
}

interface SyncSkillOptions extends Partial<PreviewConfirmationOptions> {
  global?: boolean;
  confirmManagedReplacement?: boolean;
}

interface AppliedProjectChange {
  projectRoot: string;
  operation: ProjectSetupOperation;
  configPath: ".ai-qa/config.yaml";
  projectSkillPath: ".agents/skills/ai-qa-project/SKILL.md";
  writePaths: (
    ".ai-qa/config.yaml" | ".agents/skills/ai-qa-project/SKILL.md"
  )[];
  checksum: string;
  recordingMode: "local-only" | "project-skill";
  createdDirectories: string[];
}

const projectSkillMutationRequestSchema = z.object({
  projectSkill: projectSkillRequestSchema,
});

function aiQaHome(context: CliContext): string {
  return context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
}

function agentsHome(context: CliContext): string {
  return context.env.AI_QA_AGENTS_HOME ?? join(context.homeDir, ".agents");
}

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

function bundledSourcePath(): string {
  return fileURLToPath(
    new URL("../../skills/global/SKILL.md", import.meta.url),
  );
}

function requestedSetupAction(
  options: PreviewConfirmationOptions,
): { kind: "preview" } | { kind: "apply"; checksum: string } {
  if (options.preview === true && options.confirmChecksum !== undefined) {
    throw new AiQaError(
      "setup.conflicting_confirmation",
      "Use either --preview or --confirm-checksum, not both",
    );
  }
  if (options.preview === true) return { kind: "preview" };
  if (options.confirmChecksum !== undefined) {
    return { kind: "apply", checksum: options.confirmChecksum };
  }
  throw new AiQaError(
    "setup.confirmation_required",
    "Preview the complete change or provide its confirmed checksum",
  );
}

function parseChecksum(value: string): string {
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return value;
  throw new InvalidArgumentError(
    "checksum must match sha256:<64 lowercase hexadecimal characters>",
  );
}

function addProjectMutationOptions(command: Command, stdinRequired: boolean) {
  if (stdinRequired) {
    command.requiredOption(
      "--stdin-json",
      "read complete Project Skill request from stdin",
    );
  } else {
    command.option(
      "--stdin-json",
      "read complete Project Skill request from stdin",
    );
  }
  return command
    .option("--preview", "preview the complete project change")
    .addOption(
      new Option(
        "--confirm-checksum <sha256>",
        "apply the resubmitted change matching this preview checksum",
      )
        .argParser(parseChecksum)
        .conflicts("preview"),
    );
}

async function runGlobalMutation(
  context: CliContext,
  options: { confirmManagedReplacement?: boolean },
): Promise<void> {
  const input = {
    agentsHome: agentsHome(context),
    sourcePath: bundledSourcePath(),
  };
  const preview = await previewGlobalSkillSync(input);
  if (
    preview.requiresConfirmation &&
    options.confirmManagedReplacement !== true
  ) {
    throw new AiQaError(
      "skill.confirmation_required",
      "Confirm replacement of locally edited service-managed skill content",
      {
        destination: preview.destination,
        unifiedDiff: preview.unifiedDiff,
      },
    );
  }
  const status = await syncGlobalSkill({
    ...input,
    confirmManagedReplacement: options.confirmManagedReplacement === true,
  });
  writeJson(context, status);
}

function appliedProjectChange(
  preview: ProjectSetupPreview,
): AppliedProjectChange {
  return {
    projectRoot: preview.projectRoot,
    operation: preview.operation,
    configPath: preview.configPath,
    projectSkillPath: preview.projectSkillPath,
    writePaths: preview.writePaths,
    checksum: preview.checksum,
    recordingMode: preview.config.recordingPolicy.mode,
    createdDirectories: [],
  };
}

async function runProjectMutation(input: {
  command: Command;
  context: CliContext;
  operation: "skill-generate" | "skill-sync";
  options: PreviewConfirmationOptions;
}): Promise<void> {
  const project = explicitProject(input.command);
  const home = aiQaHome(input.context);
  const resolved = await resolveTrustedProject({
    cwd: input.context.cwd,
    aiQaHome: home,
    ...(project === undefined ? {} : { explicitProject: project }),
  });
  const action = requestedSetupAction(input.options);
  const mutation = await readJsonInput(
    input.context,
    projectSkillMutationRequestSchema,
  );
  const request = {
    config: await readProjectConfig(resolved.projectRoot),
    projectSkill: mutation.projectSkill,
  };
  if (action.kind === "preview") {
    writeJson(
      input.context,
      await previewProjectSetup({
        operation: input.operation,
        projectRoot: resolved.projectRoot,
        aiQaHome: home,
        request,
      }),
    );
    return;
  }
  const applied = await applyProjectSetup({
    operation: input.operation,
    projectRoot: resolved.projectRoot,
    aiQaHome: home,
    request,
    confirmChecksum: action.checksum,
  });
  writeJson(input.context, appliedProjectChange(applied));
}

export function registerSkillCommands(
  program: Command,
  context: CliContext,
  requestExitCode: (exitCode: number) => void,
): void {
  const skillCommand = program
    .command("skill")
    .description("manage global and target-project AI QA skills");

  skillCommand
    .command("install")
    .description("install the service-managed global AI QA skill")
    .requiredOption("--global", "target the global agent skill directory")
    .option(
      "--confirm-managed-replacement",
      "replace locally edited service-managed skill content",
    )
    .action(async (options: MutatingGlobalSkillOptions) => {
      await runGlobalMutation(context, options);
    });

  const generateCommand = addProjectMutationOptions(
    skillCommand
      .command("generate")
      .description("create a missing target-project AI QA Skill"),
    true,
  );
  generateCommand.action(async (options: PreviewConfirmationOptions) => {
    await runProjectMutation({
      command: generateCommand,
      context,
      operation: "skill-generate",
      options,
    });
  });

  const syncCommand = addProjectMutationOptions(
    skillCommand
      .command("sync")
      .description("sync the global or target-project AI QA Skill")
      .option("--global", "target the global agent skill directory")
      .option(
        "--confirm-managed-replacement",
        "replace locally edited service-managed skill content",
      ),
    false,
  );
  syncCommand.action(async (options: SyncSkillOptions) => {
    if (options.global !== true && options.confirmManagedReplacement === true) {
      throw new AiQaError(
        "skill.conflicting_scope_options",
        "Global Skill replacement confirmation cannot be used for a project Skill",
      );
    }
    if (options.global === true) {
      if (
        options.stdinJson === true ||
        options.preview === true ||
        options.confirmChecksum !== undefined
      ) {
        throw new AiQaError(
          "skill.conflicting_scope_options",
          "Project Skill setup options cannot be used with --global",
        );
      }
      await runGlobalMutation(context, options);
      return;
    }
    if (options.stdinJson !== true) {
      throw new AiQaError(
        "input.stdin_required",
        "Project Skill sync requires --stdin-json",
      );
    }
    await runProjectMutation({
      command: syncCommand,
      context,
      operation: "skill-sync",
      options: options as PreviewConfirmationOptions,
    });
  });

  skillCommand
    .command("check")
    .description("check a global or target-project AI QA Skill")
    .option("--global", "target the global agent skill directory")
    .action(async (options: { global?: boolean }, command: Command) => {
      if (options.global === true) {
        const status = await checkGlobalSkill({
          agentsHome: agentsHome(context),
          sourcePath: bundledSourcePath(),
        });
        writeJson(context, status);
        if (status.status !== "compatible") requestExitCode(1);
        return;
      }
      const project = explicitProject(command);
      const home = aiQaHome(context);
      const resolved = await resolveTrustedProject({
        cwd: context.cwd,
        aiQaHome: home,
        ...(project === undefined ? {} : { explicitProject: project }),
      });
      const config = await readProjectConfig(resolved.projectRoot);
      const installed = await inspectOptionalProjectLocalRegularFile(
        resolved.projectRoot,
        [".agents", "skills", "ai-qa-project", "SKILL.md"],
      );
      const status = inspectProjectSkill({
        projectRoot: resolved.projectRoot,
        ...(installed.content === undefined
          ? {}
          : { content: installed.content }),
        secretReferences: config.secretReferences,
      });
      writeJson(context, status);
      if (status.status !== "compatible") requestExitCode(1);
    });
}
