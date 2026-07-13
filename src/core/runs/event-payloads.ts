import { z } from "zod";
import { jsonValueSchema } from "../json-value.js";

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
    stepId: z.string().trim().min(1),
    target: targetSchema,
    recoveryForStepId: z.string().trim().min(1).optional(),
  })
  .strict();

const terminalActionPayloadSchema = z
  .object({
    phase: z.enum(["completed", "unknown"]),
    actionId: z.string().trim().min(1),
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
