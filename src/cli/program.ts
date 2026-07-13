import { Command, CommanderError } from "commander";
import type { CliContext } from "./context.js";

export function createProgram(context: CliContext): Command {
  return new Command()
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
      context.writeStderr(
        `${JSON.stringify({ error: { code, message: error.message } })}\n`,
      );
      return error.exitCode === 0 ? 1 : error.exitCode;
    }
    throw error;
  }
}
