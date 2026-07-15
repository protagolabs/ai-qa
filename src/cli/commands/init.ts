import { join } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { AiQaError } from "../../core/errors.js";
import {
  applyProjectSetup,
  previewProjectSetup,
} from "../../services/initialization/initialize-project.js";
import {
  initializationRequestSchema,
  type InitializationRequest,
  type ProjectSetupOperation,
  type ProjectSetupPreview,
} from "../../services/initialization/project-setup.js";
import { resolveProjectRoot } from "../../services/project-root/resolve-project-root.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

interface PreviewConfirmationOptions {
  stdinJson: boolean;
  preview?: boolean;
  confirmChecksum?: string;
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

function aiQaHome(context: CliContext): string {
  return context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
}

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
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

function addConfirmationOptions(command: Command): Command {
  return command
    .requiredOption("--stdin-json", "read complete setup request from stdin")
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
    createdDirectories:
      preview.operation === "init"
        ? ["cases", "runs", "evidence", "reports/runs"]
        : [],
  };
}

async function runSetup(input: {
  context: CliContext;
  projectRoot: string;
  aiQaHome: string;
  operation: "init" | "configure";
  request: InitializationRequest;
  action: ReturnType<typeof requestedSetupAction>;
}): Promise<void> {
  if (input.action.kind === "preview") {
    writeJson(
      input.context,
      await previewProjectSetup({
        operation: input.operation,
        projectRoot: input.projectRoot,
        aiQaHome: input.aiQaHome,
        request: input.request,
      }),
    );
    return;
  }
  const applied = await applyProjectSetup({
    operation: input.operation,
    projectRoot: input.projectRoot,
    aiQaHome: input.aiQaHome,
    request: input.request,
    confirmChecksum: input.action.checksum,
  });
  writeJson(input.context, appliedProjectChange(applied));
}

export function registerInitCommands(
  program: Command,
  context: CliContext,
): void {
  const initCommand = addConfirmationOptions(
    program
      .command("init")
      .description("initialize trusted project config and Project Skill"),
  );

  initCommand.action(async (options: PreviewConfirmationOptions) => {
    const project = explicitProject(initCommand);
    const resolved = await resolveProjectRoot({
      command: "init",
      cwd: context.cwd,
      ...(project === undefined ? {} : { explicitProject: project }),
    });
    const action = requestedSetupAction(options);
    const request = await readJsonInput(context, initializationRequestSchema);
    await runSetup({
      context,
      projectRoot: resolved.root,
      aiQaHome: aiQaHome(context),
      operation: "init",
      request,
      action,
    });
  });

  const configureCommand = addConfirmationOptions(
    program
      .command("configure")
      .description("replace complete project config and Project Skill state"),
  );

  configureCommand.action(async (options: PreviewConfirmationOptions) => {
    const project = explicitProject(configureCommand);
    const home = aiQaHome(context);
    const resolved = await resolveTrustedProject({
      cwd: context.cwd,
      aiQaHome: home,
      ...(project === undefined ? {} : { explicitProject: project }),
    });
    const action = requestedSetupAction(options);
    const request = await readJsonInput(context, initializationRequestSchema);
    await runSetup({
      context,
      projectRoot: resolved.projectRoot,
      aiQaHome: home,
      operation: "configure",
      request,
      action,
    });
  });
}
