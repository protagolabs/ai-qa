import { z } from "zod";
import { runGroupIdSchema } from "../run-groups/schema.js";
import { runIdSchema } from "../runs/schema.js";

const reportRunIdSchema = runIdSchema.refine(
  (id) => !runGroupIdSchema.safeParse(id).success,
  "Run report subjects require a run ID, not a run-group ID",
);

export const reportSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), id: reportRunIdSchema }).strict(),
  z.object({ kind: z.literal("run-group"), id: runGroupIdSchema }).strict(),
]);

export type ReportSubject = z.infer<typeof reportSubjectSchema>;

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

const receiptPayloadFields = {
  status: z.enum(["recorded", "not_recorded", "unknown"]),
  references: z.array(recordingReferenceSchema).max(20),
};

type StatusReferences = {
  status: "recorded" | "not_recorded" | "unknown";
  references: string[];
};

function validateStoredStatusReferences(
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

function validatePublicStatusReferences(
  value: StatusReferences,
  context: z.core.$RefinementCtx,
): void {
  validateStoredStatusReferences(value, context);
  if (value.status === "unknown" && value.references.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["references"],
      message: "Unknown receipts require an empty reference list",
    });
  }
}

export const recordingReceiptInputSchema = z
  .object(receiptPayloadFields)
  .strict()
  .superRefine(validatePublicStatusReferences);

export type RecordingReceiptInput = z.infer<typeof recordingReceiptInputSchema>;

export const recordingEventSchema = z
  .object({
    ...receiptPayloadFields,
    idempotencyKey: recordingIdempotencyKeySchema,
    schemaVersion: z.literal(2),
    eventId: recordingEventIdSchema,
    subject: reportSubjectSchema,
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(validateStoredStatusReferences);

export type RecordingEvent = z.infer<typeof recordingEventSchema>;

export const recordingArtifactSchema = z
  .object({
    schemaVersion: z.literal(2),
    subject: reportSubjectSchema,
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
