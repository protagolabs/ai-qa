import { z } from "zod";
import { runIdSchema } from "../runs/schema.js";

export const recordingIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/u);

export const recordingEventIdSchema = z
  .string()
  .regex(
    /^recording-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );

export const recordingReferenceSchema = z
  .string()
  .superRefine((value, context) => {
    const codePointLength = [...value].length;
    if (
      codePointLength < 1 ||
      codePointLength > 2048 ||
      // eslint-disable-next-line no-control-regex -- C0/C1 are forbidden by the receipt contract.
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Recording references require 1-2048 non-control Unicode code points",
      });
    }
  });

const receiptFields = {
  idempotencyKey: recordingIdempotencyKeySchema,
  status: z.enum(["recorded", "not_recorded", "unknown"]),
  references: z.array(recordingReferenceSchema).max(20),
};

type StatusReferences = {
  status: "recorded" | "not_recorded" | "unknown";
  references: string[];
};

function validateStatusReferences(
  value: StatusReferences,
  context: z.core.$RefinementCtx,
): void {
  if (value.status === "recorded" && value.references.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["references"],
      message: "Recorded receipts require at least one reference",
    });
  }
  if (value.status === "not_recorded" && value.references.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["references"],
      message: "Not-recorded receipts require an empty reference list",
    });
  }
}

export const recordingReceiptInputSchema = z
  .object(receiptFields)
  .strict()
  .superRefine(validateStatusReferences);

export type RecordingReceiptInput = z.infer<typeof recordingReceiptInputSchema>;

export const recordingEventSchema = z
  .object({
    ...receiptFields,
    schemaVersion: z.literal(1),
    eventId: recordingEventIdSchema,
    runId: runIdSchema,
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(validateStatusReferences);

export type RecordingEvent = z.infer<typeof recordingEventSchema>;

export const recordingArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: runIdSchema,
    current: z
      .object({
        eventId: recordingEventIdSchema,
        status: z.enum(["recorded", "not_recorded", "unknown"]),
        references: z.array(recordingReferenceSchema).max(20),
      })
      .strict(),
    history: z.array(
      z
        .object({
          eventId: recordingEventIdSchema,
          recordedAt: z.string().datetime(),
          idempotencyKey: recordingIdempotencyKeySchema,
          status: z.enum(["recorded", "not_recorded", "unknown"]),
          references: z.array(recordingReferenceSchema).max(20),
        })
        .strict(),
    ),
    materializedAt: z.string().datetime(),
  })
  .strict();

export type RecordingArtifact = z.infer<typeof recordingArtifactSchema>;
