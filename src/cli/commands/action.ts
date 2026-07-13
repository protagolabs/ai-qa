import type { Command } from "commander";
import {
  completeActionInputSchema,
  planActionInputSchema,
} from "../../services/run-protocol/run-protocol-service.js";
import type { CliContext } from "../context.js";
import { readJsonInput } from "../io.js";
import {
  createRunProtocolService,
  writeProtocolEvent,
} from "./protocol-helpers.js";

const planBodySchema = planActionInputSchema.omit({ stepId: true });
const completeBodySchema = completeActionInputSchema.omit({ actionId: true });

export function registerActionCommands(
  program: Command,
  context: CliContext,
): void {
  const actionCommand = program
    .command("action")
    .description("record two-phase platform actions");
  const planCommand = actionCommand
    .command("plan")
    .description("record intent before invoking a platform tool")
    .requiredOption("--run <run-id>", "run ID")
    .option("--step <step-id>", "step ID")
    .requiredOption("--stdin-json", "read action input from stdin");
  planCommand.action(async (options: { run: string; step?: string }) => {
    const body = await readJsonInput(context, planBodySchema);
    const service = await createRunProtocolService(
      planCommand,
      context,
      options.run,
    );
    const event = await service.planAction({
      ...body,
      ...(options.step === undefined ? {} : { stepId: options.step }),
    });
    await writeProtocolEvent(planCommand, context, options.run, event);
  });

  const completeCommand = actionCommand
    .command("complete <action-id>")
    .description("record a completed or unknown platform result")
    .requiredOption("--run <run-id>", "run ID")
    .requiredOption("--stdin-json", "read terminal action input from stdin");
  completeCommand.action(async (actionId: string, options: { run: string }) => {
    const body = await readJsonInput(context, completeBodySchema);
    const service = await createRunProtocolService(
      completeCommand,
      context,
      options.run,
    );
    const event = await service.completeAction({ actionId, ...body });
    await writeProtocolEvent(completeCommand, context, options.run, event);
  });
}
