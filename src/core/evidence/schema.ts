import { posix } from "node:path";
import { z } from "zod";
import { EVIDENCE_SCHEMA_VERSION } from "../../schemas/versions.js";
import { actionIdSchema, runIdSchema } from "../runs/schema.js";

export const evidenceIdSchema = z
  .string()
  .regex(/^evidence-[a-z0-9][a-z0-9-]{0,126}$/);

export const normalizedRelativePosixPathSchema = z
  .string()
  .min(1)
  .superRefine((path, context) => {
    const segments = path.split("/");
    if (
      posix.isAbsolute(path) ||
      /^[a-zA-Z]:\//.test(path) ||
      path.includes("\\") ||
      posix.normalize(path) !== path ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Path must be a normalized relative POSIX path",
      });
    }
  });

const safeEvidenceFileNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine((name) => name !== "." && name !== "..");

export const evidenceRecordSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
    id: evidenceIdSchema,
    runId: runIdSchema,
    projectRelativePath: normalizedRelativePosixPathSchema,
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaType: z.string().min(1),
    platform: z.literal("web"),
    sourceTool: z.string().min(1),
    capturedAt: z.string().datetime(),
    classification: z.enum(["raw", "redacted", "annotated"]),
    sensitivity: z.enum(["public", "internal", "sensitive"]),
    evidenceKinds: z.array(z.string().min(1)).min(1),
    captureActionId: actionIdSchema,
    parentEvidenceId: evidenceIdSchema.optional(),
    idempotencyKey: z.string().min(1),
  })
  .strict()
  .superRefine((record, context) => {
    const prefix = `.ai-qa/evidence/${record.runId}/files/`;
    const fileName = record.projectRelativePath.slice(prefix.length);
    if (
      !record.projectRelativePath.startsWith(prefix) ||
      !safeEvidenceFileNameSchema.safeParse(fileName).success ||
      !fileName.startsWith(`${record.id}-`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["projectRelativePath"],
        message: "Evidence path must match its run and evidence ID",
      });
    }
  });

export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
