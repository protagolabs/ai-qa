import { Command, CommanderError } from "commander";
import { ZodError } from "zod";
import { AiQaError } from "../core/errors.js";
import { registerInitCommands } from "./commands/init.js";
import { registerTrustCommands } from "./commands/trust.js";
import type { CliContext } from "./context.js";

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
  registerInitCommands(program, context);
  registerTrustCommands(program, context);
  return program;
}

export async function runCli(
  args: readonly string[],
  context: CliContext,
): Promise<number> {
  const program = createProgram(context);
  try {
    await program.parseAsync([...args], { from: "user" });
    return 0;
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
