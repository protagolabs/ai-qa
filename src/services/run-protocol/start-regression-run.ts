import { readProjectConfig } from "../../core/config/repository.js";
import {
  projectConfigSchema,
  type ProjectConfig,
} from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import { createId } from "../../core/ids.js";
import { CaseRepository } from "../../core/cases/repository.js";
import {
  calculateCaseContentHash,
  calculateWebVariantHash,
} from "../../core/cases/schema.js";
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

interface PrepareRegressionWorkOrderInput {
  projectRoot: string;
  caseId: string;
  execution: "local" | "ci";
  readiness: PlatformReadiness;
  now: () => Date;
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
  if (readiness.platform !== "web") {
    throw new AiQaError(
      "case.platform_variant_unavailable",
      "The active case does not contain the selected platform variant",
      { platform: readiness.platform, caseId: input.caseId },
    );
  }
  const revision = await new CaseRepository(
    project.projectRoot,
    input.now,
  ).readActive(input.caseId);
  const startedAt = input.now();
  const requiredSteps = revision.variants.web.steps.map((step, order) => ({
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
    runId: createId("run"),
    kind: "regression",
    execution: input.execution,
    projectId: config.project.id,
    platform: "web",
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
      platformVariantHash: calculateWebVariantHash(revision),
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
