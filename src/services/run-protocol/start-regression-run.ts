import { readProjectConfig } from "../../core/config/repository.js";
import {
  configuredPlatforms,
  projectConfigSchema,
  type ProjectConfig,
} from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import { createId } from "../../core/ids.js";
import { CaseRepository } from "../../core/cases/repository.js";
import {
  caseRevisionSchema,
  calculateCaseContentHash,
  calculatePlatformVariantHash,
  type CaseRevision,
} from "../../core/cases/schema.js";
import type { Platform } from "../../core/platforms/schema.js";
import { RunRepository } from "../../core/runs/repository.js";
import type { PlatformReadiness } from "../../core/readiness/schema.js";
import {
  deepFreezeWorkOrder,
  readinessSchema,
  workOrderSchema,
  type ExecutionBudget,
  type WorkOrder,
} from "../../core/runs/schema.js";
import {
  WORK_ORDER_SCHEMA_VERSION,
  WORK_PROTOCOL_VERSION,
} from "../../schemas/versions.js";
import { readProjectSkillSnapshot } from "../project-skill/project-skill-file.js";
import { resolveProject } from "../project-root/resolve-project.js";

export function calculateRegressionBudget(
  requiredStepCount: number,
  startedAt: Date,
): ExecutionBudget {
  const maxToolCalls = Math.min(100, 10 + requiredStepCount * 6);
  const maxRecoveryActions = Math.min(
    10,
    Math.max(3, Math.ceil(requiredStepCount / 2)),
  );
  const minutes = Math.min(30, Math.max(10, requiredStepCount * 2));
  return {
    maxToolCalls,
    maxRecoveryActions,
    deadline: new Date(startedAt.getTime() + minutes * 60_000).toISOString(),
  };
}

export interface PrepareRegressionWorkOrderInput {
  projectRoot: string;
  caseId: string;
  platform: Platform;
  execution: "local" | "ci";
  readiness: PlatformReadiness;
  now: () => Date;
  runId?: string;
  runGroupId?: string;
  selectedRevision?: CaseRevision;
  preflightResult?: true;
  projectConfig?: ProjectConfig;
}

export async function prepareRegressionWorkOrder(
  input: PrepareRegressionWorkOrderInput,
): Promise<{ projectRoot: string; workOrder: WorkOrder }> {
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const config = projectConfigSchema.parse(
    input.projectConfig ?? (await readProjectConfig(project.projectRoot)),
  );
  const readiness = readinessSchema.parse(input.readiness);
  if (
    !configuredPlatforms(config).includes(input.platform) ||
    config.targets[input.platform] === undefined ||
    config.tools[input.platform] === undefined
  ) {
    throw new AiQaError(
      "platform.unconfigured",
      "Regression platform is not configured",
      {
        platform: input.platform,
        configuredPlatforms: configuredPlatforms(config),
      },
    );
  }
  if (readiness.platform !== input.platform) {
    throw new AiQaError(
      "platform.mismatch",
      "Regression readiness does not match the selected platform",
      {
        platform: input.platform,
        readinessPlatform: readiness.platform,
      },
    );
  }
  const revision =
    input.selectedRevision === undefined
      ? await new CaseRepository(project.projectRoot, input.now).readActive(
          input.caseId,
        )
      : caseRevisionSchema.parse(input.selectedRevision);
  if (
    revision.caseId !== input.caseId ||
    calculateCaseContentHash(revision) !== revision.contentHash
  ) {
    throw new AiQaError(
      "case.content_hash_mismatch",
      "Selected case revision identity or content hash is invalid",
      { caseId: input.caseId },
    );
  }
  const platformVariantHash = calculatePlatformVariantHash(
    revision,
    input.platform,
  );
  const variant = revision.variants[input.platform];
  if (variant === undefined) throw new Error("unreachable");
  const startedAt = input.now();
  const requiredSteps = variant.steps.map((step, order) => ({
    id: step.id,
    order,
    intent: step.intent,
    tool: step.tool,
    target: step.target,
    expectedState: step.expectedState,
    assertionStrategy: step.assertionStrategy,
    evidenceCheckpoints: step.evidenceCheckpoints,
  }));
  const projectSkill =
    config.recordingPolicy.mode === "project-skill"
      ? await readProjectSkillSnapshot(project.projectRoot)
      : undefined;
  const workOrder = workOrderSchema.parse({
    schemaVersion: WORK_ORDER_SCHEMA_VERSION,
    protocolVersion: WORK_PROTOCOL_VERSION,
    runId: input.runId ?? createId("run"),
    ...(input.runGroupId === undefined
      ? {}
      : { runGroupId: input.runGroupId }),
    kind: "regression",
    execution: input.execution,
    projectId: config.project.id,
    platform: input.platform,
    startedAt: startedAt.toISOString(),
    goal: revision.title,
    acceptanceCriteria: revision.acceptanceCriteria,
    requiredSteps,
    readiness,
    ...(input.preflightResult === undefined
      ? {}
      : { preflightResult: input.preflightResult }),
    evidencePolicy: {
      screenshots: config.evidencePolicy.screenshots,
      defaultSensitivity: config.evidencePolicy.defaultSensitivity,
    },
    recordingPolicy: config.recordingPolicy,
    ...(projectSkill === undefined ? {} : { projectSkill }),
    budget: calculateRegressionBudget(requiredSteps.length, startedAt),
    pinnedCase: {
      caseId: revision.caseId,
      revision: revision.revision,
      caseContentHash: calculateCaseContentHash(revision),
      platformVariantHash,
    },
  });
  return {
    projectRoot: project.projectRoot,
    workOrder: deepFreezeWorkOrder(workOrder) as WorkOrder,
  };
}

export async function startRegressionRun(
  input: Omit<PrepareRegressionWorkOrderInput, "preflightResult">,
): Promise<WorkOrder> {
  if (input.readiness.status !== "ready") {
    throw new AiQaError(
      "doctor.not_ready",
      "Normal regression execution requires ready platform checks",
    );
  }
  const prepared = await prepareRegressionWorkOrder(input);
  await new RunRepository(prepared.projectRoot, input.now).create(
    prepared.workOrder,
  );
  return prepared.workOrder;
}
