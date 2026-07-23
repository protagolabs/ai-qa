import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CaseRepository } from "../../core/cases/repository.js";
import { caseIdSchema } from "../../core/cases/schema.js";
import { readProjectConfig } from "../../core/config/repository.js";
import {
  configuredPlatforms,
  projectConfigSchema,
} from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import {
  ensureProjectLocalDirectory,
  sweepStaleStaging,
} from "../../core/fs/project-storage.js";
import { createId } from "../../core/ids.js";
import { platformSchema, type Platform } from "../../core/platforms/schema.js";
import {
  platformReadinessSchema,
  type PlatformReadiness,
} from "../../core/readiness/schema.js";
import {
  RunGroupRepository,
  runGroupStagingPrefix,
} from "../../core/run-groups/repository.js";
import {
  runGroupManifestSchema,
  type RunGroupExclusion,
  type RunGroupManifest,
  type RunGroupMember,
} from "../../core/run-groups/schema.js";
import type { WorkOrder } from "../../core/runs/schema.js";
import { resolveProject } from "../project-root/resolve-project.js";
import { readProjectSkillSnapshot } from "../project-skill/project-skill-file.js";
import { prepareRegressionWorkOrder } from "../run-protocol/start-regression-run.js";
import { materializeRunGroup } from "./materialize-run-group.js";

const selectionSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("explicit"),
      caseIds: z.array(caseIdSchema).min(1),
    })
    .strict()
    .refine(
      (selection) =>
        new Set(selection.caseIds).size === selection.caseIds.length,
      {
        message: "Explicit run-group case IDs must be unique",
        path: ["caseIds"],
      },
    ),
  z.object({ mode: z.literal("all-active") }).strict(),
]);

export type RunGroupSelection = z.infer<typeof selectionSchema>;

export interface StartRunGroupInput {
  projectRoot: string;
  selection: RunGroupSelection;
  platforms: Platform[];
  execution: "local" | "ci";
  readiness: Partial<Record<Platform, PlatformReadiness>>;
  now: () => Date;
}

export interface StartedRunGroup {
  manifest: RunGroupManifest;
  workOrders: WorkOrder[];
}

export async function startRunGroup(
  input: StartRunGroupInput,
): Promise<StartedRunGroup> {
  const selection = selectionSchema.parse(input.selection);
  const platforms = z.array(platformSchema).min(1).parse(input.platforms);
  if (new Set(platforms).size !== platforms.length) {
    throw new AiQaError(
      "run_group.duplicate_platform",
      "Selected run-group platforms must be unique",
    );
  }
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const config = projectConfigSchema.parse(
    await readProjectConfig(project.projectRoot),
  );
  const configured = configuredPlatforms(config);
  for (const platform of platforms) {
    if (
      !configured.includes(platform) ||
      config.targets[platform] === undefined ||
      config.tools[platform] === undefined
    ) {
      throw new AiQaError(
        "platform.unconfigured",
        "Run-group platform is not configured",
        { platform, configuredPlatforms: configured },
      );
    }
  }
  const readiness = new Map<Platform, PlatformReadiness>();
  for (const platform of platforms) {
    const value = platformReadinessSchema.parse(input.readiness[platform]);
    if (value.platform !== platform) {
      throw new AiQaError(
        "platform.mismatch",
        "Run-group readiness does not match the selected platform",
        { platform, readinessPlatform: value.platform },
      );
    }
    if (value.status !== "ready") {
      throw new AiQaError(
        "doctor.not_ready",
        "Normal run-group execution requires ready platform checks",
        { platform },
      );
    }
    readiness.set(platform, value);
  }

  const cases = new CaseRepository(project.projectRoot, input.now);
  const projectSkill =
    config.recordingPolicy.mode === "project-skill"
      ? await readProjectSkillSnapshot(project.projectRoot)
      : undefined;
  const revisions =
    selection.mode === "explicit"
      ? await Promise.all(
          selection.caseIds.map((caseId) => cases.readActive(caseId)),
        )
      : await cases.listActive();
  if (revisions.length === 0) {
    throw new AiQaError(
      "run_group.no_active_cases",
      "Run-group selection did not resolve any active cases",
    );
  }

  const runGroupId = `run-group-${randomUUID()}`;
  const createdAt = input.now();
  const members: RunGroupMember[] = [];
  const exclusions: RunGroupExclusion[] = [];
  const workOrders: WorkOrder[] = [];
  for (const revision of revisions) {
    for (const platform of platforms) {
      if (revision.variants[platform] === undefined) {
        exclusions.push({
          caseId: revision.caseId,
          revision: revision.revision,
          caseContentHash: revision.contentHash,
          platform,
          reason: "missing_variant",
        });
        continue;
      }
      const runId = createId("run");
      const prepared = await prepareRegressionWorkOrder({
        projectRoot: project.projectRoot,
        caseId: revision.caseId,
        platform,
        execution: input.execution,
        readiness: readiness.get(platform)!,
        now: () => createdAt,
        runId,
        runGroupId,
        selectedRevision: revision,
        projectConfig: config,
      });
      const pinned = prepared.workOrder.pinnedCase;
      if (pinned === undefined) throw new Error("missing regression pin");
      workOrders.push(prepared.workOrder);
      members.push({
        runId,
        caseId: pinned.caseId,
        revision: pinned.revision,
        caseContentHash: pinned.caseContentHash,
        platform,
        platformVariantHash: pinned.platformVariantHash,
        budget: { ...prepared.workOrder.budget },
        workOrder: prepared.workOrder,
      });
    }
  }
  const maximumBudget = members.reduce(
    (total, member) => ({
      maxToolCalls: total.maxToolCalls + member.budget.maxToolCalls,
      maxRecoveryActions:
        total.maxRecoveryActions + member.budget.maxRecoveryActions,
    }),
    { maxToolCalls: 0, maxRecoveryActions: 0 },
  );
  const manifest = runGroupManifestSchema.parse({
    schemaVersion: 1,
    id: runGroupId,
    projectId: config.project.id,
    execution: input.execution,
    selectionMode: selection.mode,
    selectedPlatforms: platforms,
    createdAt: createdAt.toISOString(),
    recordingPolicy: config.recordingPolicy,
    ...(projectSkill === undefined ? {} : { projectSkill }),
    members,
    exclusions,
    maximumBudget,
  });

  const runGroupsRoot = await ensureProjectLocalDirectory(project.projectRoot, [
    ".ai-qa",
    "run-groups",
  ]);
  await sweepStaleStaging(runGroupsRoot, runGroupStagingPrefix, input.now);

  const storedManifest = await new RunGroupRepository(
    project.projectRoot,
    input.now,
  ).create(manifest);
  try {
    await materializeRunGroup({
      projectRoot: project.projectRoot,
      runGroupId,
      now: input.now,
    });
  } catch (error: unknown) {
    throw new AiQaError(
      "run_group.materialization_failed",
      "Run-group manifest is persisted but child materialization is incomplete; resume the frozen group",
      {
        runGroupId,
        causeCode:
          error instanceof AiQaError ? error.code : "internal.unexpected_error",
      },
    );
  }
  return { manifest: storedManifest, workOrders };
}
