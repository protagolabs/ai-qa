import type { Command } from "commander";
import { observationPayloadSchema } from "../../core/runs/event-payloads.js";
import type { CliContext } from "../context.js";
import { readJsonInput } from "../io.js";
import {
  createRunProtocolService,
  writeProtocolEvent,
} from "./protocol-helpers.js";

export function registerObservationCommands(
  program: Command,
  context: CliContext,
): void {
  const observationCommand = program
    .command("observation")
    .description("record current UI observations");
  const addCommand = observationCommand
    .command("add")
    .requiredOption("--run <run-id>", "run ID")
    .requiredOption("--stdin-json", "read observation input from stdin");
  addCommand.action(async (options: { run: string }) => {
    const body = await readJsonInput(context, observationPayloadSchema);
    const service = await createRunProtocolService(
      addCommand,
      context,
      options.run,
    );
    await writeProtocolEvent(
      addCommand,
      context,
      options.run,
      await service.addObservation(body),
    );
  });
}
