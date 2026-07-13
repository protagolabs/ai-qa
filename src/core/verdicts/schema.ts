import { z } from "zod";
import { evidenceIdSchema } from "../evidence/schema.js";
import { criterionIdSchema, eventIdSchema } from "../runs/schema.js";

export const blockerSubtypeSchema = z.enum([
  "environment",
  "tool",
  "permission",
  "data",
  "evidence",
]);

export const criterionResultSchema = z
  .object({
    criterionId: criterionIdSchema,
    status: z.enum(["satisfied", "violated", "indeterminate"]),
    assertionIds: z.array(eventIdSchema),
    evidenceIds: z.array(evidenceIdSchema),
  })
  .strict();

export const blockerPayloadSchema = z
  .object({
    subtype: blockerSubtypeSchema,
    condition: z.string().trim().min(1),
    attemptEventIds: z.array(eventIdSchema).min(1),
    criterionIds: z.array(criterionIdSchema),
  })
  .strict();

const common = {
  summary: z.string().trim().min(1),
  criterionResults: z.array(criterionResultSchema),
  supersedes: eventIdSchema.optional(),
};

export const verdictPayloadSchema = z
  .discriminatedUnion("classification", [
    z.object({ classification: z.literal("pass"), ...common }).strict(),
    z.object({ classification: z.literal("fail"), ...common }).strict(),
    z
      .object({
        classification: z.literal("blocked"),
        ...common,
        blockerSubtype: blockerSubtypeSchema,
        blockerIds: z.array(eventIdSchema).min(1),
      })
      .strict(),
    z
      .object({
        classification: z.literal("not_verified"),
        ...common,
        reasonCode: z.enum([
          "budget_exhausted",
          "cancelled",
          "incomplete_coverage",
          "unknown_action",
        ]),
      })
      .strict(),
  ])
  .superRefine((payload, context) => {
    const criterionIds = payload.criterionResults.map(
      (result) => result.criterionId,
    );
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["criterionResults"],
        message: "Criterion results must have unique criterion IDs",
      });
    }
  });

export type BlockerPayload = z.infer<typeof blockerPayloadSchema>;
export type CriterionResult = z.infer<typeof criterionResultSchema>;
export type VerdictPayload = z.infer<typeof verdictPayloadSchema>;
