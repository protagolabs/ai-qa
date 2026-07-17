import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { readProjectConfig } from "../../core/config/repository.js";
import {
  configuredPlatforms,
  type ProjectConfigV3,
} from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import { platformSchema, type Platform } from "../../core/platforms/schema.js";
import {
  platformDoctorInputSchema,
  type PlatformDoctorObservationInput,
} from "../../core/readiness/schema.js";
import { runInstallationDoctor } from "../../services/doctor/installation-doctor.js";
import { runPlatformDoctor } from "../../services/doctor/platform-doctor.js";
import { resolveProjectRoot } from "../../services/project-root/resolve-project-root.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

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
      const platform = hasPlatform
        ? platformSchema.parse(options.platform)
        : undefined;

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
      if (
        platform === undefined ||
        !configuredPlatforms(config).includes(platform) ||
        config.targets[platform] === undefined ||
        config.tools[platform] === undefined
      ) {
        throw new AiQaError(
          "platform.unconfigured",
          `Platform ${String(platform)} is not configured`,
          {
            platform,
            configuredPlatforms: configuredPlatforms(config),
          },
        );
      }

      const input = await readPlatformObservations(context, platform);
      const result = await runConfiguredPlatformDoctor({
        platform,
        config,
        input,
        installationChecks: installation.checks,
        fetchImpl: context.fetchImpl,
      });
      writeJson(context, { ...result, requiredAction: null });
    },
  );
}

async function readPlatformObservations(
  context: CliContext,
  platform: Platform,
): Promise<PlatformDoctorObservationInput> {
  const observations = await readJsonInput(
    context,
    z.record(z.string(), z.unknown()),
  );
  return platformDoctorInputSchema.parse({ ...observations, platform });
}

async function runConfiguredPlatformDoctor(input: {
  platform: Platform;
  config: ProjectConfigV3;
  input: PlatformDoctorObservationInput;
  installationChecks: Awaited<
    ReturnType<typeof runInstallationDoctor>
  >["checks"];
  fetchImpl: typeof fetch;
}) {
  switch (input.platform) {
    case "web": {
      if (input.input.platform !== input.platform) return mismatchedPlatform();
      return runPlatformDoctor({
        platform: input.platform,
        target: input.config.targets.web!,
        installationChecks: input.installationChecks,
        observations: {
          ...(input.input.entryPage === undefined
            ? {}
            : { entryPage: input.input.entryPage }),
          chromeDevtoolsMcp: input.input.chromeDevtoolsMcp,
        },
        fetchImpl: input.fetchImpl,
      });
    }
    case "ios-simulator": {
      if (input.input.platform !== input.platform) return mismatchedPlatform();
      return runPlatformDoctor({
        platform: input.platform,
        target: input.config.targets["ios-simulator"]!,
        installationChecks: input.installationChecks,
        observations: {
          simulator: input.input.simulator,
          app: input.input.app,
          pepper: input.input.pepper,
        },
        fetchImpl: input.fetchImpl,
      });
    }
    case "android-emulator": {
      if (input.input.platform !== input.platform) return mismatchedPlatform();
      return runPlatformDoctor({
        platform: input.platform,
        target: input.config.targets["android-emulator"]!,
        tool: input.config.tools["android-emulator"]!,
        installationChecks: input.installationChecks,
        observations: {
          emulator: input.input.emulator,
          app: input.input.app,
          appium: input.input.appium,
          uiautomator2: input.input.uiautomator2,
        },
        fetchImpl: input.fetchImpl,
      });
    }
  }
}

function mismatchedPlatform(): never {
  throw new AiQaError(
    "platform.mismatch",
    "Doctor observations do not match the selected platform",
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
