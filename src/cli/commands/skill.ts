import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { AiQaError } from "../../core/errors.js";
import {
  checkGlobalSkill,
  previewGlobalSkillSync,
  syncGlobalSkill,
} from "../../services/skill-management/global-skill.js";
import type { CliContext } from "../context.js";
import { writeJson } from "../io.js";

interface MutatingGlobalSkillOptions {
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

async function runGlobalMutation(
  context: CliContext,
  options: MutatingGlobalSkillOptions,
): Promise<void> {
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
}

export function registerSkillCommands(
  program: Command,
  context: CliContext,
  requestExitCode: (exitCode: number) => void,
): void {
  const skillCommand = program
    .command("skill")
    .description("manage the global AI QA skill");

  skillCommand
    .command("install")
    .description("install the service-managed global AI QA skill")
    .requiredOption("--global", "target the global agent skill directory")
    .option(
      "--confirm-managed-replacement",
      "replace locally edited service-managed skill content",
    )
    .action(async (options: MutatingGlobalSkillOptions) => {
      await runGlobalMutation(context, options);
    });

  skillCommand
    .command("sync")
    .description("sync the service-managed global AI QA skill")
    .requiredOption("--global", "target the global agent skill directory")
    .option(
      "--confirm-managed-replacement",
      "replace locally edited service-managed skill content",
    )
    .action(async (options: MutatingGlobalSkillOptions) => {
      await runGlobalMutation(context, options);
    });

  skillCommand
    .command("check")
    .description("check the service-managed global AI QA skill")
    .requiredOption("--global", "target the global agent skill directory")
    .action(async () => {
      const status = await checkGlobalSkill({
        agentsHome: agentsHome(context),
        sourcePath: bundledSourcePath(),
      });
      writeJson(context, status);
      if (status.status !== "compatible") requestExitCode(1);
    });
}
