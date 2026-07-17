import { Command } from "commander";
import { z } from "zod";
import { caseIdSchema } from "../../core/cases/schema.js";
import { AiQaError } from "../../core/errors.js";
import { platformSchema, type Platform } from "../../core/platforms/schema.js";
import {
  platformReadinessSchema,
  type PlatformReadiness,
} from "../../core/readiness/schema.js";
import { cancelRunGroup } from "../../services/run-groups/cancel-run-group.js";
import { finishRunGroup } from "../../services/run-groups/finish-run-group.js";
import {
  materializeRunGroup,
} from "../../services/run-groups/materialize-run-group.js";
import { startRunGroup } from "../../services/run-groups/start-run-group.js";
import { resolveProject } from "../../services/project-root/resolve-project.js";
import type { CliContext } from "../context.js";
import { readJsonInput, writeJson } from "../io.js";

const optionsSchema = z
  .object({
    case: z.array(caseIdSchema).optional(),
    allActive: z.boolean().optional(),
    platform: z.array(platformSchema).min(1),
    execution: z.enum(["local", "ci"]),
    stdinJson: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (options) =>
      (options.allActive === true) !== ((options.case?.length ?? 0) > 0),
    {
      message: "Select either explicit --case values or --all-active",
      path: ["case"],
    },
  );

const doctorReadinessInputSchema = platformReadinessSchema
  .extend({ requiredAction: z.unknown().optional() })
  .transform(({ platform, status, checks }) => ({
    platform,
    status,
    checks,
  }));

const readinessMapSchema = z
  .object({
    web: doctorReadinessInputSchema.optional(),
    "ios-simulator": doctorReadinessInputSchema.optional(),
    "android-emulator": doctorReadinessInputSchema.optional(),
  })
  .strict();

const startInputSchema = z.union([
  readinessMapSchema.transform((readiness) => ({ readiness })),
  z.object({ readiness: readinessMapSchema }).strict(),
]);

function explicitProject(command: Command): string | undefined {
  const value: unknown = command.optsWithGlobals().project;
  return typeof value === "string" ? value : undefined;
}

export function registerRunGroupCommands(
  program: Command,
  context: CliContext,
): void {
  const group = program
    .command("run-group")
    .description("manage immutable multi-platform run groups");

  const start = group
    .command("start")
    .description("prepare and persist an immutable run group")
    .option("--case <case-id...>", "active case IDs")
    .option("--all-active", "select every active case")
    .requiredOption("--platform <platform...>", "target platforms")
    .requiredOption("--execution <execution>", "execution mode")
    .requiredOption("--stdin-json", "read per-platform readiness from stdin");
  start.action(
    async (raw: {
      case?: string[];
      allActive?: boolean;
      platform: string[];
      execution: string;
      stdinJson?: true;
    }) => {
      const options = optionsSchema.parse(raw);
      const target = await resolveTarget(start, context);
      const supplied = await readJsonInput(context, startInputSchema);
      const readiness: Partial<Record<Platform, PlatformReadiness>> = {};
      for (const platform of options.platform) {
        const value = supplied.readiness[platform];
        if (value === undefined) {
          throw new AiQaError(
            "run_group.readiness_missing",
            "Selected run-group platform is missing readiness input",
            { platform },
          );
        }
        readiness[platform] = value;
      }
      writeJson(
        context,
        await startRunGroup({
          ...target,
          selection:
            options.allActive === true
              ? { mode: "all-active" }
              : { mode: "explicit", caseIds: options.case! },
          platforms: options.platform,
          execution: options.execution,
          readiness,
          now: context.now,
        }),
      );
    },
  );

  const finish = group
    .command("finish <group-id>")
    .description("complete a group after every member is terminal");
  finish.action(async (runGroupId: string) => {
    writeJson(
      context,
      await finishRunGroup({
        ...(await resolveTarget(finish, context)),
        runGroupId,
        now: context.now,
      }),
    );
  });

  const resume = group
    .command("resume <group-id>")
    .description("materialize missing children from the frozen group manifest");
  resume.action(async (runGroupId: string) => {
    writeJson(
      context,
      await materializeRunGroup({
        ...(await resolveTarget(resume, context)),
        runGroupId,
        now: context.now,
      }),
    );
  });

  const cancel = group
    .command("cancel <group-id>")
    .description("canonically cancel every non-terminal group member")
    .requiredOption("--reason <reason>", "cancellation reason");
  cancel.action(async (runGroupId: string, options: { reason: string }) => {
    writeJson(
      context,
      await cancelRunGroup({
        ...(await resolveTarget(cancel, context)),
        runGroupId,
        reason: options.reason,
        now: context.now,
      }),
    );
  });
}

async function resolveTarget(
  command: Command,
  context: CliContext,
): Promise<{ projectRoot: string }> {
  const projectOption = explicitProject(command);
  const project = await resolveProject({
    cwd: context.cwd,
    ...(projectOption === undefined ? {} : { explicitProject: projectOption }),
  });
  return { projectRoot: project.projectRoot };
}
