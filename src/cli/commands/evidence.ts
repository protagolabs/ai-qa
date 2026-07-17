import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { AiQaError } from "../../core/errors.js";
import { controllerSchema } from "../../core/platforms/schema.js";
import { resolveProject } from "../../services/project-root/resolve-project.js";
import { registerEvidence } from "../../services/run-protocol/register-evidence.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

const evidenceInputSchema = z
  .object({
    mediaType: z.string().trim().min(1),
    sourceTool: controllerSchema,
    sensitivity: z.enum(["public", "internal", "sensitive"]),
    evidenceKinds: z.array(z.string().trim().min(1)).min(1),
    captureActionId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
    criterionIds: z.array(z.string().trim().min(1)),
    observationIds: z.array(z.string().trim().min(1)),
  })
  .strict();

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

async function rejectOtherProjectStateSource(
  sourcePath: string,
  projectRoot: string,
): Promise<string> {
  const canonicalSource = await realpath(sourcePath);
  let current = dirname(canonicalSource);
  for (;;) {
    if (basename(current) === ".ai-qa") {
      if (dirname(current) !== projectRoot) {
        throw new AiQaError(
          "evidence.source_forbidden",
          "Evidence source cannot come from another project's .ai-qa state",
          { sourcePath: canonicalSource },
        );
      }
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return canonicalSource;
}

export function registerEvidenceCommands(
  program: Command,
  context: CliContext,
): void {
  const evidenceCommand = program
    .command("evidence")
    .description("manage immutable QA evidence");
  const addCommand = evidenceCommand
    .command("add")
    .description("register an immutable raw evidence file")
    .requiredOption("--run <run-id>", "run ID")
    .requiredOption("--file <path>", "raw evidence source path")
    .requiredOption("--stdin-json", "read evidence metadata from stdin");

  addCommand.action(async (options: { run: string; file: string }) => {
    const projectOption = explicitProject(addCommand);
    const project = await resolveProject({
      cwd: context.cwd,
      ...(projectOption === undefined
        ? {}
        : { explicitProject: projectOption }),
    });
    const sourcePath = await rejectOtherProjectStateSource(
      resolve(context.cwd, options.file),
      project.projectRoot,
    );
    const input = await readJsonInput(context, evidenceInputSchema);
    const record = await registerEvidence({
      projectRoot: project.projectRoot,
      runId: options.run,
      payload: {
        sourcePath,
        mediaType: input.mediaType,
        sourceTool: input.sourceTool,
        sensitivity: input.sensitivity,
        evidenceKinds: input.evidenceKinds,
        captureActionId: input.captureActionId,
        idempotencyKey: input.idempotencyKey,
      },
      criterionIds: input.criterionIds,
      observationIds: input.observationIds,
      now: context.now,
    });
    writeJson(context, record);
  });
}
