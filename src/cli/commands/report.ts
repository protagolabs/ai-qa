import type { Command } from "commander";
import { AiQaError } from "../../core/errors.js";
import { recordingReceiptInputSchema } from "../../core/recording/schema.js";
import type { RunGroupReport } from "../../core/reports/group-schema.js";
import {
  generateRunGroupReport,
  type GeneratedRunGroupReport,
  withVerifiedGeneratedRunGroupReport,
} from "../../services/report-generation/generate-group-report.js";
import {
  generateRunReport,
  type GeneratedRunReport,
  withVerifiedGeneratedRunReport,
} from "../../services/report-generation/generate-run-report.js";
import type { RunReport } from "../../core/reports/schema.js";
import {
  readGroupRecordingStatus,
  readRecordingStatus,
  registerGroupRecordingReceipt,
  registerRecordingReceipt,
} from "../../services/report-generation/recording-receipt.js";
import { resolveProject } from "../../services/project-root/resolve-project.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

async function groupReportInput(
  command: Command,
  context: CliContext,
  runGroupId: string,
) {
  const projectOption = explicitProject(command);
  const project = await resolveProject({
    cwd: context.cwd,
    ...(projectOption === undefined ? {} : { explicitProject: projectOption }),
  });
  return {
    projectRoot: project.projectRoot,
    runGroupId,
    now: context.now,
  };
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

function pathsOnly(report: GeneratedRunReport | GeneratedRunGroupReport): {
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

function requestCiGroupFailure(
  report: RunGroupReport,
  requestExitCode: (exitCode: number) => void,
): void {
  if (
    report.group.execution === "ci" &&
    (report.group.status !== "completed" ||
      report.matrix.some((cell) => cell.status !== "pass"))
  ) {
    requestExitCode(1);
  }
}

function requestCiRunFailure(
  report: RunReport,
  requestExitCode: (exitCode: number) => void,
): void {
  if (
    report.run.execution === "ci" &&
    (report.run.status !== "completed" ||
      report.verdict.classification !== "pass")
  ) {
    requestExitCode(1);
  }
}

export function registerReportCommands(
  program: Command,
  context: CliContext,
  requestExitCode: (exitCode: number) => void,
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
    requestCiRunFailure(generated.report, requestExitCode);
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
    await withVerifiedGeneratedRunReport(
      await reportInput(exportCommand, context, runId),
      (verified) => {
        writeJson(context, verified.paths);
        requestCiRunFailure(verified.report, requestExitCode);
        return Promise.resolve();
      },
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

  const groupGenerateCommand = reportCommand
    .command("group-generate <group-id>")
    .description("generate configured project-local run-group report formats");
  groupGenerateCommand.action(async (runGroupId: string) => {
    const generated = await generateRunGroupReport(
      await groupReportInput(groupGenerateCommand, context, runGroupId),
    );
    writeJson(context, pathsOnly(generated));
    requestCiGroupFailure(generated.report, requestExitCode);
  });

  const groupExportCommand = reportCommand
    .command("group-export <group-id>")
    .description("export an already generated run-group report")
    .requiredOption("--adapter <adapter>", "report storage adapter");
  groupExportCommand.action(
    async (runGroupId: string, options: { adapter: string }) => {
      if (options.adapter !== "project-local") {
        throw new AiQaError(
          "adapter.unsupported_in_increment_1",
          "Increment 1 supports only the project-local report adapter",
          { adapter: options.adapter },
        );
      }
      await withVerifiedGeneratedRunGroupReport(
        await groupReportInput(groupExportCommand, context, runGroupId),
        (verified) => {
          writeJson(context, verified.paths);
          requestCiGroupFailure(verified.report, requestExitCode);
          return Promise.resolve();
        },
      );
    },
  );

  const groupReceiptCommand = reportCommand
    .command("group-receipt <group-id>")
    .description("register a host-provided project group-recording receipt")
    .requiredOption("--stdin-json", "read recording receipt from stdin");
  groupReceiptCommand.action(async (runGroupId: string) => {
    const registered = await registerGroupRecordingReceipt({
      ...(await groupReportInput(groupReceiptCommand, context, runGroupId)),
      receipt: await readJsonInput(context, recordingReceiptInputSchema),
    });
    writeJson(context, {
      eventId: registered.event.eventId,
      status: registered.event.status,
      references: registered.event.references,
      replayed: registered.replayed,
    });
  });

  const groupRecordingStatusCommand = reportCommand
    .command("group-recording-status <group-id>")
    .description("read verified project group-recording status");
  groupRecordingStatusCommand.action(async (runGroupId: string) => {
    writeJson(
      context,
      await readGroupRecordingStatus(
        await groupReportInput(
          groupRecordingStatusCommand,
          context,
          runGroupId,
        ),
      ),
    );
  });
}
