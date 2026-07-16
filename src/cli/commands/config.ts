import type { Command } from "commander";
import { projectConfigV2Schema } from "../../core/config/schema.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

export function registerConfigCommands(
  program: Command,
  context: CliContext,
): void {
  const config = program
    .command("config")
    .description("validate AI QA configuration drafts");
  config
    .command("validate")
    .description("validate a schema-v2 config without writing project files")
    .requiredOption(
      "--stdin-json",
      "read the complete config object from stdin",
    )
    .action(async () => {
      const parsed = await readJsonInput(context, projectConfigV2Schema);
      writeJson(context, { status: "valid", config: parsed });
    });
}
