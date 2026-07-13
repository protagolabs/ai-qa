import { join } from "node:path";
import type { Command } from "commander";
import { AiQaError } from "../../core/errors.js";
import {
  exportProjectLocalRunReport,
  generateRunReport,
  type GeneratedRunReport,
} from "../../services/report-generation/generate-run-report.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import type { CliContext } from "../context.js";
import { writeJson } from "../io.js";

function aiQaHome(context: CliContext): string {
  return context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
}

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

async function reportInput(
  command: Command,
  context: CliContext,
  runId: string,
) {
  const home = aiQaHome(context);
  const project = explicitProject(command);
  const trusted = await resolveTrustedProject({
    cwd: context.cwd,
    aiQaHome: home,
    ...(project === undefined ? {} : { explicitProject: project }),
  });
  return {
    projectRoot: trusted.projectRoot,
    aiQaHome: home,
    runId,
    now: context.now,
  };
}

function pathsOnly(report: GeneratedRunReport): {
  jsonPath?: string;
  markdownPath?: string;
} {
  return {
    ...(report.jsonPath === undefined ? {} : { jsonPath: report.jsonPath }),
    ...(report.markdownPath === undefined
      ? {}
      : { markdownPath: report.markdownPath }),
  };
}

export function registerReportCommands(
  program: Command,
  context: CliContext,
): void {
  const reportCommand = program
    .command("report")
    .description("generate and export QA run reports");
  const generateCommand = reportCommand
    .command("generate <run-id>")
    .description("generate configured project-local run report formats");
  generateCommand.action(async (runId: string) => {
    const generated = await generateRunReport(
      await reportInput(generateCommand, context, runId),
    );
    writeJson(context, pathsOnly(generated));
  });

  const exportCommand = reportCommand
    .command("export <run-id>")
    .description("export an already generated run report")
    .requiredOption("--adapter <adapter>", "report storage adapter");
  exportCommand.action(async (runId: string, options: { adapter: string }) => {
    if (options.adapter !== "project-local") {
      throw new AiQaError(
        "adapter.unsupported_in_increment_1",
        "Increment 1 supports only the project-local report adapter",
        { adapter: options.adapter },
      );
    }
    writeJson(
      context,
      await exportProjectLocalRunReport(
        await reportInput(exportCommand, context, runId),
      ),
    );
  });
}
