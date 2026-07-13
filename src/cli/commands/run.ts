import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { caseIdSchema } from "../../core/cases/schema.js";
import { exploratoryRunInputSchema } from "../../core/runs/schema.js";
import type { WebDoctorResult } from "../../services/doctor/web-doctor.js";
import { resolveTrustedProject } from "../../services/project-root/resolve-trusted-project.js";
import { createPreflightResultRun } from "../../services/run-protocol/create-preflight-result-run.js";
import { finalizeRun } from "../../services/run-protocol/finalize-run.js";
import { readRunState } from "../../services/run-protocol/read-run-state.js";
import {
  cancelRun,
  resumeRun,
} from "../../services/run-protocol/run-lifecycle.js";
import { startExploratoryRun } from "../../services/run-protocol/start-exploratory-run.js";
import { startRegressionRun } from "../../services/run-protocol/start-regression-run.js";
import { checkGlobalSkill } from "../../services/skill-management/global-skill.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

const startOptionsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exploratory"),
    platform: z.literal("web"),
    execution: z.literal("local"),
    case: z.undefined().optional(),
  }),
  z.object({
    kind: z.literal("regression"),
    platform: z.literal("web"),
    execution: z.enum(["local", "ci"]),
    case: caseIdSchema,
  }),
]);

const doctorCheckSchema = z
  .object({
    code: z.enum([
      "web.entry_url",
      "web.entry_page",
      "web.readiness_url",
      "web.chrome_devtools_mcp",
      "agent.global_skill",
    ]),
    status: z.enum(["pass", "fail", "agent_confirmation_required"]),
    message: z.string().min(1),
  })
  .strict();

const webReadinessSchema = z
  .object({
    platform: z.literal("web"),
    status: z.enum(["ready", "not_ready"]),
    checks: z.array(doctorCheckSchema),
  })
  .strict();

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

export function registerRunCommands(
  program: Command,
  context: CliContext,
): void {
  const runCommand = program.command("run").description("manage QA runs");
  const startCommand = runCommand
    .command("start")
    .description("create an immutable run work order")
    .requiredOption("--kind <kind>", "run kind")
    .option("--case <case-id>", "active regression case ID")
    .requiredOption("--platform <platform>", "target platform")
    .requiredOption("--execution <execution>", "execution mode")
    .requiredOption("--stdin-json", "read confirmed run input from stdin");

  startCommand.action(
    async (options: {
      kind: string;
      platform: string;
      execution: string;
      case?: string;
    }) => {
      const parsedOptions = startOptionsSchema.parse(options);
      const project = explicitProject(startCommand);
      const home = aiQaHome(context);
      const resolved = await resolveTrustedProject({
        cwd: context.cwd,
        aiQaHome: home,
        ...(project === undefined ? {} : { explicitProject: project }),
      });
      const suppliedExploratory =
        parsedOptions.kind === "exploratory"
          ? await readJsonInput(context, exploratoryRunInputSchema)
          : undefined;
      const suppliedRegression =
        parsedOptions.kind === "regression"
          ? await readJsonInput(context, webReadinessSchema)
          : undefined;
      const readiness =
        parsedOptions.kind === "exploratory"
          ? webReadinessSchema.parse(suppliedExploratory!.readiness)
          : suppliedRegression!;
      const globalSkill = await checkGlobalSkill({
        agentsHome: agentsHome(context),
        sourcePath: bundledSourcePath(),
      });
      const checks = [
        ...readiness.checks.filter(
          (check) => check.code !== "agent.global_skill",
        ),
        {
          code: "agent.global_skill" as const,
          status:
            globalSkill.status === "compatible"
              ? ("pass" as const)
              : ("fail" as const),
          message: `Global skill status: ${globalSkill.status}`,
        },
      ];
      const verifiedReadiness: WebDoctorResult = {
        platform: "web",
        status: checks.every((check) => check.status === "pass")
          ? "ready"
          : "not_ready",
        checks,
      };
      if (parsedOptions.kind === "regression") {
        if (verifiedReadiness.status === "ready") {
          writeJson(
            context,
            await startRegressionRun({
              projectRoot: resolved.projectRoot,
              aiQaHome: home,
              caseId: parsedOptions.case,
              execution: parsedOptions.execution,
              readiness: verifiedReadiness,
              now: context.now,
            }),
          );
          return;
        }
        writeJson(
          context,
          await createPreflightResultRun({
            projectRoot: resolved.projectRoot,
            aiQaHome: home,
            kind: "regression",
            caseId: parsedOptions.case,
            execution: parsedOptions.execution,
            readiness: { ...verifiedReadiness, status: "not_ready" },
            now: context.now,
          }),
        );
        return;
      }

      const payload = exploratoryRunInputSchema.parse({
        ...suppliedExploratory,
        readiness: verifiedReadiness,
      });
      if (verifiedReadiness.status === "ready") {
        writeJson(
          context,
          await startExploratoryRun({
            projectRoot: resolved.projectRoot,
            aiQaHome: home,
            payload,
            now: context.now,
          }),
        );
        return;
      }
      writeJson(
        context,
        await createPreflightResultRun({
          projectRoot: resolved.projectRoot,
          aiQaHome: home,
          kind: "exploratory",
          exploratoryPayload: payload,
          execution: "local",
          readiness: { ...verifiedReadiness, status: "not_ready" },
          now: context.now,
        }),
      );
    },
  );

  const resumeCommand = runCommand
    .command("resume <run-id>")
    .description("resume an interrupted or inactive run safely");
  resumeCommand.action(async (runId: string) => {
    const target = await resolveRunTarget(resumeCommand, context);
    const result = await resumeRun({ ...target, runId, now: context.now });
    const state = await readRunState({ ...target, runId, now: context.now });
    writeJson(context, {
      ...result,
      permittedNextActions: state.permittedNextActions,
    });
  });

  const cancelCommand = runCommand
    .command("cancel <run-id>")
    .description("cancel a run with a terminal not_verified verdict")
    .requiredOption("--reason <reason>", "cancellation reason");
  cancelCommand.action(async (runId: string, options: { reason: string }) => {
    const target = await resolveRunTarget(cancelCommand, context);
    const result = await cancelRun({
      ...target,
      runId,
      reason: options.reason,
      now: context.now,
    });
    const state = await readRunState({ ...target, runId, now: context.now });
    writeJson(context, {
      ...result,
      permittedNextActions: state.permittedNextActions,
    });
  });

  const finishCommand = runCommand
    .command("finish <run-id>")
    .description("validate and complete a run");
  finishCommand.action(async (runId: string) => {
    const target = await resolveRunTarget(finishCommand, context);
    const result = await finalizeRun({
      ...target,
      runId,
      now: context.now,
    });
    const state = await readRunState({ ...target, runId, now: context.now });
    writeJson(context, {
      ...result,
      permittedNextActions: state.permittedNextActions,
    });
  });
}

async function resolveRunTarget(
  command: Command,
  context: CliContext,
): Promise<{ projectRoot: string; aiQaHome: string }> {
  const home = aiQaHome(context);
  const project = explicitProject(command);
  const trusted = await resolveTrustedProject({
    cwd: context.cwd,
    aiQaHome: home,
    ...(project === undefined ? {} : { explicitProject: project }),
  });
  return { projectRoot: trusted.projectRoot, aiQaHome: home };
}
