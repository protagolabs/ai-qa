import { z } from "zod";
import { evidenceRecordSchema } from "../evidence/schema.js";
import { jsonValueSchema } from "../json-value.js";
import {
  actionIdSchema,
  criterionIdSchema,
  eventIdSchema,
  stepIdSchema,
} from "./schema.js";

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

export const evidenceEventPayloadSchema = evidenceRecordSchema.safeExtend({
  criterionIds: z.array(criterionIdSchema),
  observationIds: z.array(eventIdSchema),
});

export type EvidenceEventPayload = z.infer<typeof evidenceEventPayloadSchema>;
