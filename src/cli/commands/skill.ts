import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Command } from "commander";
import { AiQaError } from "../../core/errors.js";
import {
  checkGlobalSkill,
  previewGlobalSkillSync,
  syncGlobalSkill,
} from "../../services/skill-management/global-skill.js";
import type { CliContext } from "../context.js";
import { writeJson } from "../io.js";

interface MutatingSkillOptions {
  global: boolean;
  confirmManagedReplacement?: boolean;
}

function agentsHome(context: CliContext): string {
  return context.env.AI_QA_AGENTS_HOME ?? join(context.homeDir, ".agents");
}

function bundledSourcePath(): string {
  return fileURLToPath(
    new URL("../../skills/global/SKILL.md", import.meta.url),
  );
}

function registerMutatingCommand(
  skillCommand: Command,
  context: CliContext,
  name: "install" | "sync",
): void {
  skillCommand
    .command(name)
    .description(`${name} the service-managed global AI QA skill`)
    .requiredOption("--global", "target the global agent skill directory")
    .option(
      "--confirm-managed-replacement",
      "replace locally edited service-managed skill content",
    )
    .action(async (options: MutatingSkillOptions) => {
      const input = {
        agentsHome: agentsHome(context),
        sourcePath: bundledSourcePath(),
      };
      const preview = await previewGlobalSkillSync(input);
      if (
        preview.requiresConfirmation &&
        options.confirmManagedReplacement !== true
      ) {
        throw new AiQaError(
          "skill.confirmation_required",
          "Confirm replacement of locally edited service-managed skill content",
          {
            destination: preview.destination,
            unifiedDiff: preview.unifiedDiff,
          },
        );
      }
      const status = await syncGlobalSkill({
        ...input,
        confirmManagedReplacement: options.confirmManagedReplacement === true,
      });
      writeJson(context, status);
    });
}

export function registerSkillCommands(
  program: Command,
  context: CliContext,
  requestExitCode: (exitCode: number) => void,
): void {
  const skillCommand = program
    .command("skill")
    .description("manage the global AI QA agent skill");

  registerMutatingCommand(skillCommand, context, "install");
  registerMutatingCommand(skillCommand, context, "sync");

  skillCommand
    .command("check")
    .description("check the global AI QA skill installation")
    .requiredOption("--global", "target the global agent skill directory")
    .action(async () => {
      const status = await checkGlobalSkill({
        agentsHome: agentsHome(context),
        sourcePath: bundledSourcePath(),
      });
      writeJson(context, status);
      if (status.status !== "compatible") {
        requestExitCode(1);
      }
    });
}
