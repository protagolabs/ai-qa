import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { readProjectConfig } from "../../core/config/repository.js";
import { runWebDoctor } from "../../services/doctor/web-doctor.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import { checkGlobalSkill } from "../../services/skill-management/global-skill.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

const agentCapabilityObservationSchema = z.object({
  status: z.enum(["ready", "missing", "unknown"]),
  observedAt: z.string().datetime(),
  evidence: z.string().min(1),
});

const doctorInputSchema = z.object({
  entryPage: agentCapabilityObservationSchema.optional(),
  chromeDevtoolsMcp: agentCapabilityObservationSchema,
});

function aiQaHome(context: CliContext): string {
  return context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
}

function agentsHome(context: CliContext): string {
  return context.env.AI_QA_AGENTS_HOME ?? join(context.homeDir, ".agents");
}

function bundledSourcePath(): string {
  return fileURLToPath(
    new URL("../../skills/global/SKILL.md", import.meta.url),
  );
}

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

export function registerDoctorCommand(
  program: Command,
  context: CliContext,
): void {
  const doctorCommand = program
    .command("doctor")
    .description("check read-only target readiness")
    .requiredOption("--platform <platform>", "target platform")
    .requiredOption("--json", "emit structured JSON")
    .requiredOption("--stdin-json", "read agent observations from stdin");

  doctorCommand.action(async (options: { platform: string }) => {
    z.literal("web").parse(options.platform);
    const project = explicitProject(doctorCommand);
    const resolved = await resolveTrustedProject({
      cwd: context.cwd,
      aiQaHome: aiQaHome(context),
      ...(project === undefined ? {} : { explicitProject: project }),
    });
    const config = await readProjectConfig(resolved.projectRoot);
    const input = await readJsonInput(context, doctorInputSchema);
    const globalSkill = await checkGlobalSkill({
      agentsHome: agentsHome(context),
      sourcePath: bundledSourcePath(),
    });
    const result = await runWebDoctor({
      entryUrl: config.targets.web.entryUrl,
      ...(config.targets.web.readinessUrl === undefined
        ? {}
        : { readinessUrl: config.targets.web.readinessUrl }),
      ...(input.entryPage === undefined ? {} : { entryPage: input.entryPage }),
      chromeDevtoolsMcp: input.chromeDevtoolsMcp,
      globalSkillStatus: globalSkill.status,
      fetchImpl: context.fetchImpl,
    });
    writeJson(context, result);
  });
}
