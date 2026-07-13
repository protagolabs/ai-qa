import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { AiQaError } from "../../core/errors.js";
import { resolveProjectRoot } from "../../services/project-root/resolve-project-root.js";
import { confirmProjectTrust } from "../../services/trust/confirm-project-trust.js";
import { readRepositoryIdentity } from "../../services/trust/repository-identity.js";
import { TrustStore } from "../../services/trust/trust-store.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

const confirmInputSchema = z
  .object({
    confirmed: z.literal(true),
  })
  .strict();

function aiQaHome(context: CliContext): string {
  return context.env.AI_QA_HOME ?? join(context.homeDir, ".ai-qa");
}

function requireExplicitProject(command: Command): string {
  const value: unknown = command.optsWithGlobals().project;
  if (typeof value !== "string") {
    throw new AiQaError(
      "project.explicit_required",
      "trust commands require --project <path>",
    );
  }
  return value;
}

export function registerTrustCommands(
  program: Command,
  context: CliContext,
): void {
  const trustCommand = program
    .command("trust")
    .description("manage machine trust");

  const confirmCommand = trustCommand
    .command("confirm")
    .description("explicitly trust a repository on this machine")
    .requiredOption("--stdin-json", "read explicit confirmation from stdin");

  confirmCommand.action(async () => {
    const resolved = await resolveProjectRoot({
      command: "other",
      cwd: context.cwd,
      explicitProject: requireExplicitProject(confirmCommand),
    });
    const input = await readJsonInput(context, confirmInputSchema);
    const result = await confirmProjectTrust({
      projectRoot: resolved.root,
      aiQaHome: aiQaHome(context),
      confirmed: input.confirmed,
      now: context.now(),
    });
    writeJson(context, result);
  });

  const statusCommand = trustCommand
    .command("status")
    .description("show machine trust for a repository");

  statusCommand.action(async () => {
    const resolved = await resolveProjectRoot({
      command: "other",
      cwd: context.cwd,
      explicitProject: requireExplicitProject(statusCommand),
    });
    const identity = await readRepositoryIdentity(resolved.root);
    const trusted = await new TrustStore(aiQaHome(context)).isTrusted(identity);
    writeJson(context, {
      canonicalPath: identity.canonicalPath,
      fingerprint: identity.fingerprint,
      trusted,
    });
  });
}
