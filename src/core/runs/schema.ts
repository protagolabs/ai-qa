import { z } from "zod";
import {
  EVENT_SCHEMA_VERSION,
  WORK_ORDER_SCHEMA_VERSION,
  WORK_PROTOCOL_VERSION,
} from "../../schemas/versions.js";

export const acceptanceCriterionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  description: z.string().min(1),
  requiredEvidence: z.array(z.string().min(1)).min(1),
});

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const readinessSchema = z.object({
  platform: z.literal("web"),
  status: z.enum(["ready", "not_ready"]),
  checks: z.array(z.unknown()),
});

export const exploratoryRunInputSchema = z
  .object({
    goal: z.string().min(1),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
    readiness: readinessSchema,
  })
  .superRefine((value, context) => {
    const ids = value.acceptanceCriteria.map((criterion) => criterion.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Acceptance criterion IDs must be unique",
      });
    }
  });

export type ExploratoryRunInput = z.infer<typeof exploratoryRunInputSchema>;

export const executionBudgetSchema = z.object({
  maxToolCalls: z.number().int().positive(),
  maxRecoveryActions: z.number().int().nonnegative(),
  deadline: z.string().datetime(),
});

export type ExecutionBudget = z.infer<typeof executionBudgetSchema>;

export const workOrderSchema = z.object({
  schemaVersion: z.literal(WORK_ORDER_SCHEMA_VERSION),
  protocolVersion: z.literal(WORK_PROTOCOL_VERSION),
  runId: z.string(),
  kind: z.enum(["exploratory", "regression"]),
  execution: z.enum(["local", "ci"]),
  projectId: z.string(),
  platform: z.literal("web"),
  startedAt: z.string().datetime(),
  goal: z.string(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema),
  requiredSteps: z.array(z.unknown()),
  readiness: readinessSchema,
  evidencePolicy: z.object({
    screenshots: z.enum(["required", "on-failure", "optional"]),
    defaultSensitivity: z.enum(["public", "internal", "sensitive"]),
  }),
  budget: executionBudgetSchema,
  pinnedCase: z
    .object({
      caseId: z.string(),
      revision: z.number().int().positive(),
      caseContentHash: z.string(),
      platformVariantHash: z.string(),
    })
    .optional(),
});

export type WorkOrder = z.infer<typeof workOrderSchema>;

export function createExploratoryWorkOrder(input: {
  projectId: string;
  runId: string;
  input: ExploratoryRunInput;
  evidencePolicy: {
    screenshots: "required" | "on-failure" | "optional";
    defaultSensitivity: "public" | "internal" | "sensitive";
  };
  startedAt: Date;
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
    evidencePolicy: input.evidencePolicy,
    budget: { maxToolCalls: 100, maxRecoveryActions: 10, deadline },
  });
  return Object.freeze(value);
}

export const runEventSchema = z.object({
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  id: z.string(),
  runId: z.string(),
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
  payload: z.unknown(),
  relatedIds: z.array(z.string()),
});

export type RunEvent = z.infer<typeof runEventSchema>;
export type AppendRunEvent = Omit<
  RunEvent,
  "schemaVersion" | "id" | "runId" | "sequence" | "timestamp"
>;
