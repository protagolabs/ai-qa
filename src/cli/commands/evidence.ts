import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { AiQaError } from "../../core/errors.js";
import { webControllerSchema } from "../../core/tools.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import { registerEvidence } from "../../services/run-protocol/register-evidence.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

const evidenceInputSchema = z
  .object({
    mediaType: z.string().trim().min(1),
    sourceTool: webControllerSchema,
    sensitivity: z.enum(["public", "internal", "sensitive"]),
    evidenceKinds: z.array(z.string().trim().min(1)).min(1),
    captureActionId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
    criterionIds: z.array(z.string().trim().min(1)),
    observationIds: z.array(z.string().trim().min(1)),
  })
  .strict();

function aiQaHome(context: CliContext): string {
  return context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
}

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
    const home = aiQaHome(context);
    const project = explicitProject(addCommand);
    const trusted = await resolveTrustedProject({
      cwd: context.cwd,
      aiQaHome: home,
      ...(project === undefined ? {} : { explicitProject: project }),
    });
    const sourcePath = await rejectOtherProjectStateSource(
      resolve(context.cwd, options.file),
      trusted.projectRoot,
    );
    const input = await readJsonInput(context, evidenceInputSchema);
    const record = await registerEvidence({
      projectRoot: trusted.projectRoot,
      aiQaHome: home,
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
