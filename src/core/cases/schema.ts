import { z } from "zod";
import { sha256Canonical } from "../canonical-json.js";
import { acceptanceCriterionSchema } from "../runs/schema.js";

export const caseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

export const caseValidationIssueSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    relatedIds: z.array(z.string()),
  })
  .strict();

const excludedCaseActionSchema = z
  .object({
    actionId: z.string().min(1),
    reason: z.string(),
  })
  .strict();

export const webCaseStepSchema = z
  .object({
    id: z.string(),
    sourceActionId: z.string(),
    intent: z.string().min(1),
    tool: z.literal("chrome-devtools-mcp"),
    target: z
      .object({
        description: z.string().min(1),
        selector: z.string().min(1).optional(),
        stability: z.enum(["stable", "review-required"]),
        stabilityRationale: z.string().min(1),
      })
      .strict(),
    expectedState: z.string().min(1),
    assertionStrategy: z.string().min(1),
    evidenceCheckpoints: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const caseRevisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseId: caseIdSchema,
    revision: z.number().int().positive(),
    contentHash: z.string(),
    title: z.string().min(1),
    promotion: z
      .object({
        sourceRunId: z.string(),
        excludedActions: z.array(excludedCaseActionSchema).optional(),
        validationIssues: z.array(caseValidationIssueSchema),
      })
      .strict(),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
    variants: z
      .object({
        web: z.object({ steps: z.array(webCaseStepSchema).min(1) }).strict(),
      })
      .strict(),
  })
  .strict();

export type CaseRevision = z.infer<typeof caseRevisionSchema>;
export type CaseValidationIssue = z.infer<typeof caseValidationIssueSchema>;
export type WebCaseStep = z.infer<typeof webCaseStepSchema>;

const caseRevisionIndexEntrySchema = z
  .object({
    revision: z.number().int().positive(),
    status: z.enum(["draft", "active", "superseded", "retired"]),
    contentHash: z.string(),
    activation: z
      .object({
        confirmedBy: z.literal("user"),
        confirmedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const caseIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    title: z.string(),
    activeRevision: z.number().int().positive().optional(),
    revisions: z.array(caseRevisionIndexEntrySchema),
  })
  .strict()
  .superRefine((index, context) => {
    const revisionNumbers = index.revisions.map((entry) => entry.revision);
    if (new Set(revisionNumbers).size !== revisionNumbers.length) {
      context.addIssue({
        code: "custom",
        path: ["revisions"],
        message: "Case revision numbers must be unique",
      });
    }
    const active = index.revisions.filter((entry) => entry.status === "active");
    if (
      active.length > 1 ||
      (index.activeRevision === undefined) !== (active.length === 0) ||
      (index.activeRevision !== undefined &&
        active[0]?.revision !== index.activeRevision)
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeRevision"],
        message: "Case index must identify exactly its active revision",
      });
    }
    if (active.some((entry) => entry.activation === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["revisions"],
        message: "Active case revisions require user activation provenance",
      });
    }
  });

export type CaseIndex = z.infer<typeof caseIndexSchema>;

export function calculateCaseContentHash(
  revision: Omit<CaseRevision, "contentHash"> | CaseRevision,
): string {
  const { contentHash: ignored, ...content } = revision as CaseRevision;
  void ignored;
  return sha256Canonical(content);
}

export function calculateWebVariantHash(revision: CaseRevision): string {
  return sha256Canonical(revision.variants.web);
}
