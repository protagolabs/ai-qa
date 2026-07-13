import { join } from "node:path";
import type { Command } from "commander";
import { blockerPayloadSchema } from "../../core/verdicts/schema.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
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
    const home = context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
    const projectOption: unknown = recordCommand.optsWithGlobals().project;
    const trusted = await resolveTrustedProject({
      cwd: context.cwd,
      aiQaHome: home,
      ...(typeof projectOption === "string"
        ? { explicitProject: projectOption }
        : {}),
    });
    const service = new VerdictService(
      trusted.projectRoot,
      home,
      options.run,
      context.now,
    );
    const event = await service.recordBlocker(
      await readJsonInput(context, blockerPayloadSchema),
    );
    await writeProtocolEvent(recordCommand, context, options.run, event);
  });
}
