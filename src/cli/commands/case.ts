import { join } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import {
  activateCaseRevision,
  draftCaseFromRun,
  draftCaseInputSchema,
  validateCaseRevision,
} from "../../services/case-promotion/draft-case.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

const revisionOptionSchema = z.coerce.number().int().positive();
const activationInputSchema = z
  .object({ reviewConfirmed: z.literal(true) })
  .strict();

export function registerCaseCommands(
  program: Command,
  context: CliContext,
): void {
  const caseCommand = program
    .command("case")
    .description("promote exploratory runs into immutable cases");
  const draftCommand = caseCommand
    .command("draft")
    .requiredOption("--from-run <run-id>", "completed exploratory run ID")
    .requiredOption("--stdin-json", "read reviewed case draft from stdin");
  draftCommand.action(async (options: { fromRun: string }) => {
    const projectRoot = await trustedProjectRoot(draftCommand, context);
    const input = await readJsonInput(context, draftCaseInputSchema);
    const draftInput = {
      ...input,
      webSteps: input.webSteps.map((step) => ({
        ...step,
        target: {
          description: step.target.description,
          ...(step.target.selector === undefined
            ? {}
            : { selector: step.target.selector }),
          stability: step.target.stability,
          stabilityRationale: step.target.stabilityRationale,
        },
      })),
    };
    writeJson(
      context,
      await draftCaseFromRun({
        projectRoot,
        runId: options.fromRun,
        input: draftInput,
      }),
    );
  });

  const validateCommand = caseCommand
    .command("validate <case-id>")
    .requiredOption("--revision <revision>", "case revision number");
  validateCommand.action(
    async (caseId: string, options: { revision: string }) => {
      const projectRoot = await trustedProjectRoot(validateCommand, context);
      writeJson(
        context,
        await validateCaseRevision({
          projectRoot,
          caseId,
          revision: revisionOptionSchema.parse(options.revision),
        }),
      );
    },
  );

  const activateCommand = caseCommand
    .command("activate <case-id>")
    .requiredOption("--revision <revision>", "case revision number")
    .requiredOption("--stdin-json", "read exact user review confirmation");
  activateCommand.action(
    async (caseId: string, options: { revision: string }) => {
      const projectRoot = await trustedProjectRoot(activateCommand, context);
      const body = await readJsonInput(context, activationInputSchema);
      const revision = revisionOptionSchema.parse(options.revision);
      const confirmedAt = context.now().toISOString();
      const active = await activateCaseRevision({
        projectRoot,
        caseId,
        revision,
        reviewConfirmed: body.reviewConfirmed,
        now: () => new Date(confirmedAt),
      });
      writeJson(context, {
        caseId: active.caseId,
        activeRevision: active.revision,
        contentHash: active.contentHash,
        activation: { confirmedBy: "user", confirmedAt },
      });
    },
  );
}

async function trustedProjectRoot(
  command: Command,
  context: CliContext,
): Promise<string> {
  const aiQaHome = context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
  const projectOption: unknown = command.optsWithGlobals().project;
  const trusted = await resolveTrustedProject({
    cwd: context.cwd,
    aiQaHome,
    ...(typeof projectOption === "string"
      ? { explicitProject: projectOption }
      : {}),
  });
  return trusted.projectRoot;
}
