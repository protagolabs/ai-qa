import type { Command } from "commander";
import { decisionPayloadSchema } from "../../core/runs/event-payloads.js";
import type { CliContext } from "../context.js";
import { readJsonInput } from "../io.js";
import {
  createRunProtocolService,
  writeProtocolEvent,
} from "./protocol-helpers.js";

export function registerDecisionCommands(
  program: Command,
  context: CliContext,
): void {
  const decisionCommand = program
    .command("decision")
    .description("record semantic and recovery-policy decisions");
  const recordCommand = decisionCommand
    .command("record")
    .requiredOption("--run <run-id>", "run ID")
    .requiredOption("--stdin-json", "read decision input from stdin");
  recordCommand.action(async (options: { run: string }) => {
    const body = await readJsonInput(context, decisionPayloadSchema);
    const service = await createRunProtocolService(
      recordCommand,
      context,
      options.run,
    );
    await writeProtocolEvent(
      recordCommand,
      context,
      options.run,
      await service.recordDecision(body),
    );
  });
}
