import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import {
  readProjectConfig,
  writeProjectConfig,
} from "../../core/config/repository.js";
import { projectConfigSchema } from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import { initializeProject } from "../../services/initialization/initialize-project.js";
import { resolveProjectRoot } from "../../services/project-root/resolve-project-root.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import { readRepositoryIdentity } from "../../services/trust/repository-identity.js";
import { TrustStore } from "../../services/trust/trust-store.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

const initInputSchema = z.object({
  config: projectConfigSchema,
});

function aiQaHome(context: CliContext): string {
  return context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
}

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

export function registerInitCommands(
  program: Command,
  context: CliContext,
): void {
  const initCommand = program
    .command("init")
    .description("initialize trusted project-local AI QA state")
    .requiredOption("--stdin-json", "read confirmed configuration from stdin");

  initCommand.action(async () => {
    const project = explicitProject(initCommand);
    const resolved = await resolveProjectRoot({
      command: "init",
      cwd: context.cwd,
      ...(project === undefined ? {} : { explicitProject: project }),
    });
    const home = aiQaHome(context);
    const identity = await readRepositoryIdentity(resolved.root);
    if (!(await new TrustStore(home).isTrusted(identity))) {
      throw new AiQaError(
        "trust.not_trusted",
        "Confirm repository trust before initialization",
      );
    }
    const input = await readJsonInput(context, initInputSchema);
    await initializeProject({
      projectRoot: resolved.root,
      aiQaHome: home,
      config: input.config,
    });
    writeJson(context, {
      projectRoot: resolved.root,
      configPath: join(resolved.root, ".ai-qa", "config.yaml"),
      trustStore: join(home, "trust.json"),
      gitPolicy: input.config.gitPolicy,
      createdDirectories: ["cases", "runs", "evidence", "reports/runs"],
    });
  });

  const configureCommand = program
    .command("configure")
    .description("replace confirmed project configuration")
    .requiredOption("--stdin-json", "read complete configuration from stdin");

  configureCommand.action(async () => {
    const project = explicitProject(configureCommand);
    const home = aiQaHome(context);
    const resolved = await resolveTrustedProject({
      cwd: context.cwd,
      aiQaHome: home,
      ...(project === undefined ? {} : { explicitProject: project }),
    });
    const current = await readProjectConfig(resolved.projectRoot);
    const input = await readJsonInput(context, projectConfigSchema);
    const configured = {
      ...input,
      project: { ...input.project, id: current.project.id },
    };
    await writeProjectConfig(resolved.projectRoot, configured);
    writeJson(context, configured);
  });
}
