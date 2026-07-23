import { z } from "zod";
import { evidenceIdSchema, evidenceRecordSchema } from "../evidence/schema.js";
import { jsonValueSchema } from "../json-value.js";
import {
  actionIdSchema,
  criterionIdSchema,
  eventIdSchema,
  stepIdSchema,
} from "./ids.js";

const targetSchema = z
  .object({
    description: z.string().trim().min(1),
    selector: z.string().trim().min(1).optional(),
  })
  .strict();

const plannedActionPayloadSchema = z
  .object({
    phase: z.literal("planned"),
    kind: z.enum(["interaction", "observation", "evidence-capture"]),
    intent: z.string().trim().min(1),
    stepId: stepIdSchema,
    target: targetSchema,
    recoveryForStepId: stepIdSchema.optional(),
  })
  .strict();

const terminalActionPayloadSchema = z
  .object({
    phase: z.enum(["completed", "unknown"]),
    actionId: actionIdSchema,
    toolResult: z
      .object({
        summary: z.string().trim().min(1),
        data: jsonValueSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const actionPayloadSchema = z.discriminatedUnion("phase", [
  plannedActionPayloadSchema,
  terminalActionPayloadSchema,
]);

export type ActionPayload = z.infer<typeof actionPayloadSchema>;

export const observationPayloadSchema = z
  .object({
    summary: z.string().trim().min(1),
    state: z.record(z.string(), jsonValueSchema),
    stepId: stepIdSchema.optional(),
    actionId: actionIdSchema,
  })
  .strict();

export type ObservationPayload = z.infer<typeof observationPayloadSchema>;

export const assertionPayloadSchema = z
  .object({
    criterionId: criterionIdSchema,
    status: z.enum(["satisfied", "violated", "indeterminate"]),
    assertionKinds: z.array(z.string().trim().min(1)).min(1),
    actual: z.string().trim().min(1),
    expected: z.string().trim().min(1),
    observationIds: z.array(eventIdSchema),
    evidenceIds: z.array(evidenceIdSchema),
    stepId: stepIdSchema.optional(),
  })
  .strict();

export type AssertionPayload = z.infer<typeof assertionPayloadSchema>;

export const decisionPayloadSchema = z
  .object({
    kind: z.enum(["semantic", "recovery-policy"]),
    rationale: z.string().trim().min(1),
    relatedIds: z.array(z.string().trim().min(1)),
  })
  .strict();

export type DecisionPayload = z.infer<typeof decisionPayloadSchema>;

export const recoveryPayloadSchema = z
  .object({
    actionId: actionIdSchema,
    resolution: z.enum(["applied", "not_applied", "indeterminate"]),
    observationId: eventIdSchema,
    rationale: z.string().trim().min(1),
  })
  .strict();

export type RecoveryPayload = z.infer<typeof recoveryPayloadSchema>;

export const evidenceEventPayloadSchema = evidenceRecordSchema.safeExtend({
  criterionIds: z.array(criterionIdSchema),
  observationIds: z.array(eventIdSchema),
});

export type EvidenceEventPayload = z.infer<typeof evidenceEventPayloadSchema>;
