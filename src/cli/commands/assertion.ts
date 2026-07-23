import type { Command } from "commander";
import { assertionPayloadSchema } from "../../core/runs/event-payloads.js";
import type { CliContext } from "../context.js";
import { readJsonInput } from "../io.js";
import {
  createRunProtocolService,
  writeProtocolEvent,
} from "./protocol-helpers.js";

const assertionBodySchema = assertionPayloadSchema.omit({ stepId: true });

export function registerAssertionCommands(
  program: Command,
  context: CliContext,
): void {
  const assertionCommand = program
    .command("assertion")
    .description("record criterion assertions");
  const recordCommand = assertionCommand
    .command("record")
    .requiredOption("--run <run-id>", "run ID")
    .option("--step <step-id>", "step ID")
    .requiredOption("--stdin-json", "read assertion input from stdin");
  recordCommand.action(async (options: { run: string; step?: string }) => {
    const body = await readJsonInput(context, assertionBodySchema);
    const service = await createRunProtocolService(
      recordCommand,
      context,
      options.run,
    );
    const result = await service.recordAssertion({
      ...body,
      ...(options.step === undefined ? {} : { stepId: options.step }),
    });
    writeProtocolEvent(context, result);
  });
}
