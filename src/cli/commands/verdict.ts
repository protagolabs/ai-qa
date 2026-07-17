import type { Command } from "commander";
import { AiQaError } from "../../core/errors.js";
import { verdictPayloadSchema } from "../../core/verdicts/schema.js";
import { resolveProject } from "../../services/project-root/resolve-project.js";
import { VerdictService } from "../../services/run-protocol/verdict-service.js";
import type { CliContext } from "../context.js";
import { readJsonInput } from "../io.js";
import { writeProtocolEvent } from "./protocol-helpers.js";

export function registerVerdictCommands(
  program: Command,
  context: CliContext,
): void {
  const verdictCommand = program
    .command("verdict")
    .description("set and explicitly revise QA verdicts");
  const setCommand = verdictCommand
    .command("set")
    .requiredOption("--run <run-id>", "run ID")
    .requiredOption("--stdin-json", "read verdict input from stdin");
  setCommand.action(async (options: { run: string }) => {
    const service = await createVerdictService(
      setCommand,
      context,
      options.run,
    );
    const event = await service.set(
      await readJsonInput(context, verdictPayloadSchema),
    );
    await writeProtocolEvent(setCommand, context, options.run, event);
  });

  const reviseCommand = verdictCommand
    .command("revise")
    .requiredOption("--run <run-id>", "run ID")
    .requiredOption("--supersedes <verdict-id>", "effective verdict ID")
    .requiredOption("--stdin-json", "read revised verdict input from stdin");
  reviseCommand.action(async (options: { run: string; supersedes: string }) => {
    const service = await createVerdictService(
      reviseCommand,
      context,
      options.run,
    );
    const body = await readJsonInput(context, verdictPayloadSchema);
    if (body.supersedes !== undefined) {
      throw new AiQaError(
        "verdict.supersedes_in_stdin",
        "Supply verdict supersession only through --supersedes",
      );
    }
    const event = await service.revise({
      ...body,
      supersedes: options.supersedes,
    });
    await writeProtocolEvent(reviseCommand, context, options.run, event);
  });
}

async function createVerdictService(
  command: Command,
  context: CliContext,
  runId: string,
): Promise<VerdictService> {
  const projectOption: unknown = command.optsWithGlobals().project;
  const project = await resolveProject({
    cwd: context.cwd,
    ...(typeof projectOption === "string"
      ? { explicitProject: projectOption }
      : {}),
  });
  return new VerdictService(project.projectRoot, runId, context.now);
}
