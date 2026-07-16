import { z } from "zod";
import {
  EVENT_SCHEMA_VERSION,
  WORK_ORDER_SCHEMA_VERSION,
  WORK_PROTOCOL_VERSION,
} from "../../schemas/versions.js";
import { jsonValueSchema } from "../json-value.js";
import { webControllerSchema } from "../tools.js";

export const criterionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

export const eventIdSchema = z
  .string()
  .regex(/^event-[a-z0-9][a-z0-9-]{0,126}$/);

export const actionIdSchema = eventIdSchema;

export const storedWorkProtocolVersionSchema = z.enum([
  "1.0.0",
  "1.1.0",
  "1.2.0",
]);

export const projectSkillSnapshotSchema = z
  .object({
    path: z.literal(".agents/skills/ai-qa-project/SKILL.md"),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type ProjectSkillSnapshot = z.infer<typeof projectSkillSnapshotSchema>;

export const stepIdSchema = z.string().regex(/^step-[a-z0-9][a-z0-9-]{0,126}$/);

export const acceptanceCriterionSchema = z
  .object({
    id: criterionIdSchema,
    description: z.string().trim().min(1),
    requiredEvidence: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const runIdSchema = z.string().regex(/^run-[a-z0-9][a-z0-9-]{0,62}$/);

const goalSchema = z.string().trim().min(1);

const acceptanceCriteriaSchema = z
  .array(acceptanceCriterionSchema)
  .min(1)
  .superRefine((criteria, context) => {
    const ids = criteria.map((criterion) => criterion.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Acceptance criterion IDs must be unique",
      });
    }
  });

export const readinessSchema = z
  .object({
    platform: z.literal("web"),
    status: z.enum(["ready", "not_ready"]),
    checks: z.array(jsonValueSchema),
  })
  .strict();

export const exploratoryRunInputSchema = z
  .object({
    goal: goalSchema,
    acceptanceCriteria: acceptanceCriteriaSchema,
    readiness: readinessSchema,
  })
  .strict();

export type ExploratoryRunInput = z.infer<typeof exploratoryRunInputSchema>;

export const executionBudgetSchema = z
  .object({
    maxToolCalls: z.number().int().positive(),
    maxRecoveryActions: z.number().int().nonnegative(),
    deadline: z.string().datetime(),
  })
  .strict();

export type ExecutionBudget = z.infer<typeof executionBudgetSchema>;

export const requiredStepSchema = z
  .object({
    id: stepIdSchema,
    order: z.number().int().nonnegative(),
    intent: z.string().trim().min(1),
    tool: webControllerSchema,
    target: z
      .object({
        description: z.string().trim().min(1),
        selector: z.string().trim().min(1).optional(),
        stability: z.literal("stable"),
        stabilityRationale: z.string().trim().min(1),
      })
      .strict(),
    expectedState: z.string().trim().min(1),
    assertionStrategy: z.string().trim().min(1),
    evidenceCheckpoints: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export type RequiredStep = z.infer<typeof requiredStepSchema>;

const workOrderBaseSchema = z
  .object({
    schemaVersion: z.literal(WORK_ORDER_SCHEMA_VERSION),
    protocolVersion: storedWorkProtocolVersionSchema,
    runId: runIdSchema,
    kind: z.enum(["exploratory", "regression"]),
    execution: z.enum(["local", "ci"]),
    projectId: z.string(),
    platform: z.literal("web"),
    startedAt: z.string().datetime(),
    goal: goalSchema,
    acceptanceCriteria: acceptanceCriteriaSchema,
    requiredSteps: z.array(requiredStepSchema),
    readiness: readinessSchema,
    preflightResult: z.literal(true).optional(),
    evidencePolicy: z
      .object({
        screenshots: z.enum(["required", "on-failure", "optional"]),
        defaultSensitivity: z.enum(["public", "internal", "sensitive"]),
      })
      .strict(),
    recordingPolicy: z
      .object({ mode: z.enum(["local-only", "project-skill"]) })
      .strict()
      .optional(),
    projectSkill: projectSkillSnapshotSchema.optional(),
    budget: executionBudgetSchema,
    pinnedCase: z
      .object({
        caseId: z.string(),
        revision: z.number().int().positive(),
        caseContentHash: z.string(),
        platformVariantHash: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const workOrderSchema = workOrderBaseSchema.superRefine(
  (workOrder, context) => {
    const recordingMode = workOrder.recordingPolicy?.mode ?? "local-only";
    if (
      recordingMode === "local-only" &&
      workOrder.projectSkill !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["projectSkill"],
        message:
          "Local-only work orders cannot include a Project Skill snapshot",
      });
    }
    if (
      workOrder.protocolVersion === "1.2.0" &&
      recordingMode === "project-skill" &&
      workOrder.projectSkill === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["projectSkill"],
        message: "Project-skill work orders require a Project Skill snapshot",
      });
    }
    if (workOrder.kind === "regression") {
      if (workOrder.pinnedCase === undefined) {
        context.addIssue({
          code: "custom",
          path: ["pinnedCase"],
          message: "Regression work orders require a pinned case revision",
        });
      }
      if (workOrder.requiredSteps.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["requiredSteps"],
          message: "Regression work orders require at least one ordered step",
        });
      }
      const stepIds = workOrder.requiredSteps.map((step) => step.id);
      if (new Set(stepIds).size !== stepIds.length) {
        context.addIssue({
          code: "custom",
          path: ["requiredSteps"],
          message: "Regression required-step IDs must be unique",
        });
      }
      if (
        !workOrder.requiredSteps.every((step, index) => step.order === index)
      ) {
        context.addIssue({
          code: "custom",
          path: ["requiredSteps"],
          message: "Regression required steps must use contiguous array order",
        });
      }
      if (
        (workOrder.readiness.status === "not_ready") !==
        (workOrder.preflightResult === true)
      ) {
        context.addIssue({
          code: "custom",
          path: ["preflightResult"],
          message:
            "Not-ready regression work orders require the preflight-result marker",
        });
      }
      return;
    }
    if (workOrder.execution !== "local") {
      context.addIssue({
        code: "custom",
        path: ["execution"],
        message: "Exploratory work orders require local execution",
      });
    }
    if (
      (workOrder.readiness.status === "not_ready") !==
      (workOrder.preflightResult === true)
    ) {
      context.addIssue({
        code: "custom",
        path: ["preflightResult"],
        message:
          "Not-ready exploratory work orders require the preflight-result marker",
      });
    }
    if (workOrder.budget.maxToolCalls !== 100) {
      context.addIssue({
        code: "custom",
        path: ["budget", "maxToolCalls"],
        message: "Exploratory work orders require 100 tool calls",
      });
    }
    if (workOrder.budget.maxRecoveryActions !== 10) {
      context.addIssue({
        code: "custom",
        path: ["budget", "maxRecoveryActions"],
        message: "Exploratory work orders require 10 recovery actions",
      });
    }
    const expectedDeadline =
      new Date(workOrder.startedAt).getTime() + 30 * 60 * 1000;
    if (new Date(workOrder.budget.deadline).getTime() !== expectedDeadline) {
      context.addIssue({
        code: "custom",
        path: ["budget", "deadline"],
        message: "Exploratory work orders require a 30-minute deadline",
      });
    }
  },
);

export type WorkOrder = z.infer<typeof workOrderSchema>;

export function effectiveWorkOrderRecordingMode(
  workOrder: WorkOrder,
): "local-only" | "project-skill" {
  return workOrder.recordingPolicy?.mode ?? "local-only";
}

export function deepFreezeWorkOrder(workOrder: WorkOrder): Readonly<WorkOrder> {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
      return;
    }
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(workOrder);
  return workOrder;
}

export function createExploratoryWorkOrder(input: {
  projectId: string;
  runId: string;
  input: ExploratoryRunInput;
  evidencePolicy: {
    screenshots: "required" | "on-failure" | "optional";
    defaultSensitivity: "public" | "internal" | "sensitive";
  };
  recordingPolicy?: { mode: "local-only" | "project-skill" };
  projectSkill?: ProjectSkillSnapshot;
  startedAt: Date;
  preflightResult?: true;
}): Readonly<WorkOrder> {
  const deadline = new Date(
    input.startedAt.getTime() + 30 * 60 * 1000,
  ).toISOString();
  const value = workOrderSchema.parse({
    schemaVersion: WORK_ORDER_SCHEMA_VERSION,
    protocolVersion: WORK_PROTOCOL_VERSION,
    runId: input.runId,
    kind: "exploratory",
    execution: "local",
    projectId: input.projectId,
    platform: "web",
    startedAt: input.startedAt.toISOString(),
    goal: input.input.goal,
    acceptanceCriteria: input.input.acceptanceCriteria,
    requiredSteps: [],
    readiness: input.input.readiness,
    ...(input.preflightResult === undefined
      ? {}
      : { preflightResult: input.preflightResult }),
    evidencePolicy: input.evidencePolicy,
    recordingPolicy: input.recordingPolicy ?? { mode: "local-only" },
    ...(input.projectSkill === undefined
      ? {}
      : { projectSkill: input.projectSkill }),
    budget: { maxToolCalls: 100, maxRecoveryActions: 10, deadline },
  });
  return deepFreezeWorkOrder(value);
}

export const runEventSchema = z
  .object({
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    id: eventIdSchema,
    runId: runIdSchema,
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    actor: z.enum(["agent", "user", "ai-qa"]),
    platform: z.literal("web"),
    tool: z.string(),
    type: z.enum([
      "run",
      "action",
      "observation",
      "assertion",
      "evidence",
      "decision",
      "blocker",
      "verdict",
      "recovery",
    ]),
    idempotencyKey: z.string().optional(),
    payload: jsonValueSchema,
    relatedIds: z.array(z.string()),
  })
  .strict();

export type RunEvent = z.infer<typeof runEventSchema>;
export type AppendRunEvent = Omit<
  RunEvent,
  "schemaVersion" | "id" | "runId" | "sequence" | "timestamp"
>;
