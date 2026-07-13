import { z } from "zod";
import { EVIDENCE_SCHEMA_VERSION } from "../../schemas/versions.js";
import { runIdSchema } from "../runs/schema.js";

export const evidenceRecordSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
    id: z.string().min(1),
    runId: runIdSchema,
    projectRelativePath: z.string().min(1),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaType: z.string().min(1),
    platform: z.literal("web"),
    sourceTool: z.string().min(1),
    capturedAt: z.string().datetime(),
    classification: z.enum(["raw", "redacted", "annotated"]),
    sensitivity: z.enum(["public", "internal", "sensitive"]),
    evidenceKinds: z.array(z.string().min(1)).min(1),
    captureActionId: z.string().min(1),
    parentEvidenceId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
  })
  .strict();

export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
