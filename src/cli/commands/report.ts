import type { Command } from "commander";
import { AiQaError } from "../../core/errors.js";
import { recordingReceiptInputSchema } from "../../core/recording/schema.js";
import {
  exportProjectLocalRunReport,
  generateRunReport,
  type GeneratedRunReport,
} from "../../services/report-generation/generate-run-report.js";
import {
  readRecordingStatus,
  registerRecordingReceipt,
} from "../../services/report-generation/recording-receipt.js";
import { resolveProject } from "../../services/project-root/resolve-project.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

async function reportInput(
  command: Command,
  context: CliContext,
  runId: string,
) {
  const projectOption = explicitProject(command);
  const project = await resolveProject({
    cwd: context.cwd,
    ...(projectOption === undefined ? {} : { explicitProject: projectOption }),
  });
  return {
    projectRoot: project.projectRoot,
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

  const receiptCommand = reportCommand
    .command("receipt <run-id>")
    .description("register a host-provided project recording receipt")
    .requiredOption("--stdin-json", "read recording receipt from stdin");
  receiptCommand.action(async (runId: string) => {
    const registered = await registerRecordingReceipt({
      ...(await reportInput(receiptCommand, context, runId)),
      receipt: await readJsonInput(context, recordingReceiptInputSchema),
    });
    writeJson(context, {
      eventId: registered.event.eventId,
      status: registered.event.status,
      references: registered.event.references,
      replayed: registered.replayed,
    });
  });

  const recordingStatusCommand = reportCommand
    .command("recording-status <run-id>")
    .description("read verified project recording status");
  recordingStatusCommand.action(async (runId: string) => {
    writeJson(
      context,
      await readRecordingStatus(
        await reportInput(recordingStatusCommand, context, runId),
      ),
    );
  });
}
