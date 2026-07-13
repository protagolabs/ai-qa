import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { exploratoryRunInputSchema } from "../../core/runs/schema.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import { startExploratoryRun } from "../../services/run-protocol/start-exploratory-run.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

const startOptionsSchema = z.object({
  kind: z.literal("exploratory"),
  platform: z.literal("web"),
  execution: z.literal("local"),
});

function aiQaHome(context: CliContext): string {
  return context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
}

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

export function registerRunCommands(
  program: Command,
  context: CliContext,
): void {
  const runCommand = program.command("run").description("manage QA runs");
  const startCommand = runCommand
    .command("start")
    .description("create an immutable run work order")
    .requiredOption("--kind <kind>", "run kind")
    .requiredOption("--platform <platform>", "target platform")
    .requiredOption("--execution <execution>", "execution mode")
    .requiredOption("--stdin-json", "read confirmed run input from stdin");

  startCommand.action(
    async (options: { kind: string; platform: string; execution: string }) => {
      startOptionsSchema.parse(options);
      const project = explicitProject(startCommand);
      const resolved = await resolveTrustedProject({
        cwd: context.cwd,
        aiQaHome: aiQaHome(context),
        ...(project === undefined ? {} : { explicitProject: project }),
      });
      const payload = await readJsonInput(context, exploratoryRunInputSchema);
      const workOrder = await startExploratoryRun({
        projectRoot: resolved.projectRoot,
        payload,
        now: context.now,
      });
      writeJson(context, workOrder);
    },
  );
}
