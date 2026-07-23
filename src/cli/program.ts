import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import { ZodError } from "zod";
import { AiQaError, normalizeUnknownError } from "../core/errors.js";
import { registerActionCommands } from "./commands/action.js";
import { registerAssertionCommands } from "./commands/assertion.js";
import { registerBlockerCommands } from "./commands/blocker.js";
import { registerCaseCommands } from "./commands/case.js";
import { registerClearCommand } from "./commands/clear.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerDecisionCommands } from "./commands/decision.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerEvidenceCommands } from "./commands/evidence.js";
import { registerObservationCommands } from "./commands/observation.js";
import { registerRecoveryCommands } from "./commands/recovery.js";
import { registerReportCommands } from "./commands/report.js";
import { registerRunCommands } from "./commands/run.js";
import { registerRunGroupCommands } from "./commands/run-group.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerVerdictCommands } from "./commands/verdict.js";
import type { CliContext } from "./context.js";

const requestedExitCodes = new WeakMap<Command, number>();
const packageVersion = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

export function createProgram(context: CliContext): Command {
  const program = new Command()
    .name("ai-qa")
    .description("Agent-orchestrated QA state and evidence CLI")
    .version(packageVersion)
    .option("--project <path>", "explicit target-project root")
    .exitOverride()
    .configureOutput({
      writeOut: (value) => context.writeStdout(value),
      writeErr: (value) => context.writeStderr(value),
      outputError: () => undefined,
    });
  const requestExitCode = (exitCode: number) => {
    requestedExitCodes.set(program, exitCode);
  };
  registerActionCommands(program, context);
  registerAssertionCommands(program, context);
  registerBlockerCommands(program, context);
  registerCaseCommands(program, context);
  registerClearCommand(program, context);
  registerConfigCommands(program, context);
  registerDecisionCommands(program, context);
  registerDoctorCommand(program, context);
  registerEvidenceCommands(program, context);
  registerObservationCommands(program, context);
  registerRecoveryCommands(program, context);
  registerReportCommands(program, context, requestExitCode);
  registerRunCommands(program, context);
  registerRunGroupCommands(program, context);
  registerSkillCommands(program, context, requestExitCode);
  registerVerdictCommands(program, context);
  return program;
}

export function writeErrorJson(context: CliContext, error: AiQaError): void {
  context.writeStderr(
    `${JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryable ? { retryable: true } : {}),
        ...(Object.keys(error.details).length > 0
          ? { details: error.details }
          : {}),
        ...(error.issues !== undefined && error.issues.length > 0
          ? { issues: error.issues }
          : {}),
      },
    })}\n`,
  );
}

export async function runCli(
  args: readonly string[],
  context: CliContext,
): Promise<number> {
  const program = createProgram(context);
  try {
    await program.parseAsync([...args], { from: "user" });
    return requestedExitCodes.get(program) ?? 0;
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return 0;
      }
      context.writeStderr(
        `${JSON.stringify({
          error: { code: error.code, message: error.message },
        })}\n`,
      );
      return error.exitCode === 0 ? 1 : error.exitCode;
    }
    if (error instanceof AiQaError) {
      writeErrorJson(context, error);
      return 1;
    }
    if (error instanceof ZodError) {
      writeErrorJson(
        context,
        new AiQaError("schema.validation_failed", "Schema validation failed", {}, {
          issues: error.issues.map((issue) => ({
            path: issue.path.filter(
              (part): part is string | number => typeof part !== "symbol",
            ),
            code: issue.code,
            message: issue.message,
          })),
        }),
      );
      return 1;
    }
    writeErrorJson(context, normalizeUnknownError(error));
    return 1;
  }
}
