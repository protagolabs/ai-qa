import type { Command } from "commander";
import { blockerPayloadSchema } from "../../core/verdicts/schema.js";
import { resolveProject } from "../../services/project-root/resolve-project.js";
import { VerdictService } from "../../services/run-protocol/verdict-service.js";
import type { CliContext } from "../context.js";
import { readJsonInput } from "../io.js";
import { writeProtocolEvent } from "./protocol-helpers.js";

export function registerBlockerCommands(
  program: Command,
  context: CliContext,
): void {
  const blockerCommand = program
    .command("blocker")
    .description("record concrete QA blockers");
  const recordCommand = blockerCommand
    .command("record")
    .requiredOption("--run <run-id>", "run ID")
    .requiredOption("--stdin-json", "read blocker input from stdin");
  recordCommand.action(async (options: { run: string }) => {
    const projectOption: unknown = recordCommand.optsWithGlobals().project;
    const project = await resolveProject({
      cwd: context.cwd,
      ...(typeof projectOption === "string"
        ? { explicitProject: projectOption }
        : {}),
    });
    const service = new VerdictService(
      project.projectRoot,
      options.run,
      context.now,
    );
    const event = await service.recordBlocker(
      await readJsonInput(context, blockerPayloadSchema),
    );
    await writeProtocolEvent(recordCommand, context, options.run, event);
  });
}
