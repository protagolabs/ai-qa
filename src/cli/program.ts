import { Command, CommanderError } from "commander";
import { ZodError } from "zod";
import { AiQaError } from "../core/errors.js";
import { registerActionCommands } from "./commands/action.js";
import { registerAssertionCommands } from "./commands/assertion.js";
import { registerBlockerCommands } from "./commands/blocker.js";
import { registerCaseCommands } from "./commands/case.js";
import { registerDecisionCommands } from "./commands/decision.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerEvidenceCommands } from "./commands/evidence.js";
import { registerInitCommands } from "./commands/init.js";
import { registerObservationCommands } from "./commands/observation.js";
import { registerRecoveryCommands } from "./commands/recovery.js";
import { registerRunCommands } from "./commands/run.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerTrustCommands } from "./commands/trust.js";
import { registerVerdictCommands } from "./commands/verdict.js";
import type { CliContext } from "./context.js";

const requestedExitCodes = new WeakMap<Command, number>();

export function createProgram(context: CliContext): Command {
  const program = new Command()
    .name("ai-qa")
    .description("Agent-orchestrated QA state and evidence CLI")
    .version("0.0.0")
    .option("--project <path>", "explicit target-project root")
    .exitOverride()
    .configureOutput({
      writeOut: (value) => context.writeStdout(value),
      writeErr: (value) => context.writeStderr(value),
      outputError: () => undefined,
    });
  registerActionCommands(program, context);
  registerAssertionCommands(program, context);
  registerBlockerCommands(program, context);
  registerCaseCommands(program, context);
  registerDecisionCommands(program, context);
  registerDoctorCommand(program, context);
  registerEvidenceCommands(program, context);
  registerInitCommands(program, context);
  registerObservationCommands(program, context);
  registerRecoveryCommands(program, context);
  registerRunCommands(program, context);
  registerSkillCommands(program, context, (exitCode) => {
    requestedExitCodes.set(program, exitCode);
  });
  registerTrustCommands(program, context);
  registerVerdictCommands(program, context);
  return program;
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
      const code =
        error.code === "commander.excessArguments" &&
        program.commands.length === 0
          ? "commander.unknownCommand"
          : error.code;
      const message =
        error.code === "commander.unknownCommand"
          ? `error: too many arguments. Expected 0 arguments but got ${String(args.length)}.`
          : error.message;
      context.writeStderr(`${JSON.stringify({ error: { code, message } })}\n`);
      return error.exitCode === 0 ? 1 : error.exitCode;
    }
    if (error instanceof AiQaError) {
      context.writeStderr(
        `${JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        })}\n`,
      );
      return 1;
    }
    if (error instanceof ZodError) {
      context.writeStderr(
        `${JSON.stringify({
          error: {
            code: "schema.validation_failed",
            message: "Schema validation failed",
            details: { issuePaths: error.issues.map((issue) => issue.path) },
          },
        })}\n`,
      );
      return 1;
    }
    throw error;
  }
}
