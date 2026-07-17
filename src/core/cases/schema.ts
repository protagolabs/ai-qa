import { z } from "zod";
import { CASE_SCHEMA_VERSION } from "../../schemas/versions.js";
import { sha256Canonical } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { controllerMatchesPlatform } from "../platforms/registry.js";
import {
  controllerSchema,
  platformSchema,
  type Platform,
} from "../platforms/schema.js";
import {
  acceptanceCriterionSchema,
  actionIdSchema,
  runIdSchema,
  stepIdSchema,
} from "../runs/schema.js";

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
    actionId: actionIdSchema,
    reason: z.string(),
  })
  .strict();

export const targetDescriptionSchema = z
  .object({
    description: z.string().trim().min(1),
    selector: z.string().trim().min(1).optional(),
    stability: z.enum(["stable", "review-required"]),
    stabilityRationale: z.string().trim().min(1),
  })
  .strict();

export const caseStepSchema = z
  .object({
    id: stepIdSchema,
    sourceActionId: actionIdSchema,
    intent: z.string().trim().min(1),
    tool: controllerSchema,
    target: targetDescriptionSchema,
    expectedState: z.string().trim().min(1),
    assertionStrategy: z.string().trim().min(1),
    evidenceCheckpoints: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export const caseVariantSchema = z
  .object({
    steps: z.array(caseStepSchema).min(1),
  })
  .strict();

const caseVariantMapSchema = z
  .object({
    web: caseVariantSchema.optional(),
    "ios-simulator": caseVariantSchema.optional(),
    "android-emulator": caseVariantSchema.optional(),
  })
  .strict()
  .refine(
    (variants) =>
      platformSchema.options.some(
        (platform) => variants[platform] !== undefined,
      ),
    { message: "Case revision requires at least one platform variant" },
  );

const casePromotionSourceSchema = z
  .object({
    sourceRunId: runIdSchema,
    excludedActions: z.array(excludedCaseActionSchema).optional(),
  })
  .strict();

const casePromotionSourcesSchema = z
  .object({
    web: casePromotionSourceSchema.optional(),
    "ios-simulator": casePromotionSourceSchema.optional(),
    "android-emulator": casePromotionSourceSchema.optional(),
  })
  .strict();

export const caseRevisionSchema = z
  .object({
    schemaVersion: z.literal(CASE_SCHEMA_VERSION),
    caseId: caseIdSchema,
    revision: z.number().int().positive(),
    contentHash: z.string(),
    title: z.string().trim().min(1),
    promotion: z
      .object({
        sources: casePromotionSourcesSchema,
        validationIssues: z.array(caseValidationIssueSchema),
      })
      .strict(),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
    variants: caseVariantMapSchema,
  })
  .strict()
  .superRefine((revision, context) => {
    const variantKeys = platformSchema.options.filter(
      (platform) => revision.variants[platform] !== undefined,
    );
    const sourceKeys = platformSchema.options.filter(
      (platform) => revision.promotion.sources[platform] !== undefined,
    );
    if (
      variantKeys.length !== sourceKeys.length ||
      variantKeys.some((platform, index) => platform !== sourceKeys[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["promotion", "sources"],
        message: "Promotion source keys must equal platform variant keys",
      });
    }
    for (const platform of variantKeys) {
      const variant = revision.variants[platform];
      if (variant === undefined) continue;
      for (const [index, step] of variant.steps.entries()) {
        if (!controllerMatchesPlatform(platform, step.tool)) {
          context.addIssue({
            code: "custom",
            path: ["variants", platform, "steps", index, "tool"],
            message: "Case step controller must match its variant platform",
          });
        }
      }
    }
  });

export type CaseRevision = z.infer<typeof caseRevisionSchema>;
export type CaseValidationIssue = z.infer<typeof caseValidationIssueSchema>;
export type CaseStep = z.infer<typeof caseStepSchema>;
export type CaseVariant = z.infer<typeof caseVariantSchema>;

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

export function calculatePlatformVariantHash(
  revision: CaseRevision,
  platform: Platform,
): string {
  const variant = revision.variants[platform];
  if (variant === undefined) {
    throw new AiQaError(
      "case.variant_missing",
      "Case revision does not contain the selected platform variant",
      { caseId: revision.caseId, revision: revision.revision, platform },
    );
  }
  return sha256Canonical(variant);
}
