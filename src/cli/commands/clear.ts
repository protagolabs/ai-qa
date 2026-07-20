import type { Command } from "commander";
import { clearProject } from "../../services/project-clear/clear-project.js";
import { resolveProjectRoot } from "../../services/project-root/resolve-project-root.js";
import type { CliContext } from "../context.js";
import { writeJson } from "../io.js";

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

export function registerClearCommand(
  program: Command,
  context: CliContext,
): void {
  const clearCommand = program
    .command("clear")
    .description("clear project-local AI QA configuration")
    .option("--records", "delete all project-local AI QA records");

  clearCommand.action(async (options: { records?: boolean }) => {
    const selectedProject = explicitProject(clearCommand);
    const project = await resolveProjectRoot({
      command: "clear",
      cwd: context.cwd,
      ...(selectedProject === undefined
        ? {}
        : { explicitProject: selectedProject }),
    });
    writeJson(
      context,
      await clearProject({
        projectRoot: project.root,
        records: options.records === true,
      }),
    );
  });
}
