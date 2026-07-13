import type { Command } from "commander";
import { recoveryPayloadSchema } from "../../core/runs/event-payloads.js";
import type { CliContext } from "../context.js";
import { readJsonInput } from "../io.js";
import {
  createRunProtocolService,
  writeProtocolEvent,
} from "./protocol-helpers.js";

const recoveryBodySchema = recoveryPayloadSchema.omit({ actionId: true });

export function registerRecoveryCommands(
  program: Command,
  context: CliContext,
): void {
  const recoveryCommand = program
    .command("recovery")
    .description("resolve ambiguous platform actions");
  const resolveCommand = recoveryCommand
    .command("resolve <action-id>")
    .requiredOption("--run <run-id>", "run ID")
    .requiredOption("--stdin-json", "read recovery input from stdin");
  resolveCommand.action(async (actionId: string, options: { run: string }) => {
    const body = await readJsonInput(context, recoveryBodySchema);
    const service = await createRunProtocolService(
      resolveCommand,
      context,
      options.run,
    );
    await writeProtocolEvent(
      resolveCommand,
      context,
      options.run,
      await service.resolveUnknownAction({ actionId, ...body }),
    );
  });
}
