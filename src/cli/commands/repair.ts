import type { Command } from "commander";
import { resolveProject } from "../../services/project-root/resolve-project.js";
import { repairRun } from "../../services/run-repair/repair-run.js";
import type { CliContext } from "../context.js";
import { writeJson } from "../io.js";

export function registerRunRepairCommand(
  runCommand: Command,
  context: CliContext,
): void {
  const repairCommand = runCommand
    .command("repair <run-id>")
    .description("repair crash-orphaned evidence and torn journal tails");
  repairCommand.action(async (runId: string) => {
    const projectOption: unknown = repairCommand.optsWithGlobals().project;
    const project = await resolveProject({
      cwd: context.cwd,
      ...(typeof projectOption === "string"
        ? { explicitProject: projectOption }
        : {}),
    });
    writeJson(
      context,
      await repairRun({
        projectRoot: project.projectRoot,
        runId,
        now: context.now,
      }),
    );
  });
}
