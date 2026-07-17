import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { readProjectConfig } from "../../core/config/repository.js";
import { AiQaError } from "../../core/errors.js";
import { runInstallationDoctor } from "../../services/doctor/installation-doctor.js";
import { runWebDoctor } from "../../services/doctor/web-doctor.js";
import { resolveProjectRoot } from "../../services/project-root/resolve-project-root.js";
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
    .option("--platform <platform>", "target platform")
    .requiredOption("--json", "emit structured JSON")
    .option("--stdin-json", "read agent observations from stdin");

  doctorCommand.action(
    async (options: { platform?: string; stdinJson?: boolean }) => {
      const hasPlatform = options.platform !== undefined;
      const hasStdin = options.stdinJson === true;
      if (hasPlatform !== hasStdin) {
        throw new AiQaError(
          "doctor.options_pair_required",
          "--platform and --stdin-json must be supplied together",
        );
      }
      if (hasPlatform) z.literal("web").parse(options.platform);

      const project = explicitProject(doctorCommand);
      const root = await resolveProjectRoot({
        command: "init",
        cwd: context.cwd,
        ...(project === undefined ? {} : { explicitProject: project }),
      });
      const installationInput = {
        projectRoot: root.root,
        agentsHome: agentsHome(context),
        sourcePath: bundledSourcePath(),
      };
      if (!(await storedConfigExists(root.root))) {
        writeJson(context, await runInstallationDoctor(installationInput));
        return;
      }

      const installation = await runInstallationDoctor(installationInput);
      if (!hasPlatform || installation.status === "uninitialized") {
        writeJson(context, installation);
        return;
      }
      const configCheck = installation.checks.find(
        (check) => check.code === "project.config",
      );
      if (configCheck?.status !== "pass") {
        writeJson(context, installation);
        return;
      }

      const config = await readProjectConfig(root.root);
      const input = await readJsonInput(context, doctorInputSchema);
      const result = await runWebDoctor({
        installationChecks: installation.checks,
        entryUrl: config.targets.web.entryUrl,
        ...(config.targets.web.readinessUrl === undefined
          ? {}
          : { readinessUrl: config.targets.web.readinessUrl }),
        ...(input.entryPage === undefined
          ? {}
          : { entryPage: input.entryPage }),
        chromeDevtoolsMcp: input.chromeDevtoolsMcp,
        fetchImpl: context.fetchImpl,
      });
      writeJson(context, { ...result, requiredAction: null });
    },
  );
}

async function storedConfigExists(projectRoot: string): Promise<boolean> {
  try {
    await lstat(join(projectRoot, ".ai-qa", "config.yaml"));
    return true;
  } catch (error: unknown) {
    return !isNodeError(error, "ENOENT");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
