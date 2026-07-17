import type { Command } from "commander";
import { projectConfigSchema } from "../../core/config/schema.js";
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
    .description("validate a schema-v3 config without writing project files")
    .requiredOption(
      "--stdin-json",
      "read the complete config object from stdin",
    )
    .action(async () => {
      const parsed = await readJsonInput(context, projectConfigSchema);
      writeJson(context, { status: "valid", config: parsed });
    });
}
