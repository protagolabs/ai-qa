import { z } from "zod";
import { caseIdSchema } from "../cases/schema.js";
import { eventIdSchema, runIdSchema } from "../runs/schema.js";
import { platformSchema } from "../platforms/schema.js";

export const runGroupIdSchema = z
  .string()
  .regex(/^run-group-[a-z0-9][a-z0-9-]{0,126}$/u);

const immutableBudgetSchema = z
  .object({
    maxToolCalls: z.number().int().positive(),
    maxRecoveryActions: z.number().int().nonnegative(),
    deadline: z.string().datetime(),
  })
  .strict();

const maximumBudgetSchema = z
  .object({
    maxToolCalls: z.number().int().nonnegative(),
    maxRecoveryActions: z.number().int().nonnegative(),
  })
  .strict();

export const runGroupMemberSchema = z
  .object({
    runId: runIdSchema,
    caseId: caseIdSchema,
    revision: z.number().int().positive(),
    caseContentHash: z.string().trim().min(1),
    platform: platformSchema,
    platformVariantHash: z.string().trim().min(1),
    budget: immutableBudgetSchema,
  })
  .strict();

export const runGroupExclusionSchema = z
  .object({
    caseId: caseIdSchema,
    revision: z.number().int().positive(),
    caseContentHash: z.string().trim().min(1),
    platform: platformSchema,
    reason: z.literal("missing_variant"),
  })
  .strict();

export const runGroupManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: runGroupIdSchema,
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
    execution: z.enum(["local", "ci"]),
    selectionMode: z.enum(["explicit", "all-active"]),
    selectedPlatforms: z.array(platformSchema).min(1),
    createdAt: z.string().datetime(),
    members: z.array(runGroupMemberSchema),
    exclusions: z.array(runGroupExclusionSchema),
    maximumBudget: maximumBudgetSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      new Set(manifest.selectedPlatforms).size !==
      manifest.selectedPlatforms.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedPlatforms"],
        message: "Selected run-group platforms must be unique",
      });
    }
    const runIds = manifest.members.map((member) => member.runId);
    if (new Set(runIds).size !== runIds.length) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "Run-group member run IDs must be unique",
      });
    }
    const cells = [
      ...manifest.members.map(
        (member) => `${member.caseId}\u0000${member.platform}`,
      ),
      ...manifest.exclusions.map(
        (exclusion) => `${exclusion.caseId}\u0000${exclusion.platform}`,
      ),
    ];
    if (new Set(cells).size !== cells.length) {
      context.addIssue({
        code: "custom",
        path: ["members"],
        message: "Run-group case/platform cells must be unique",
      });
    }
    if (
      [...manifest.members, ...manifest.exclusions].some(
        (entry) => !manifest.selectedPlatforms.includes(entry.platform),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedPlatforms"],
        message: "Every run-group cell must use a selected platform",
      });
    }
    const expectedMaximum = manifest.members.reduce(
      (total, member) => ({
        maxToolCalls: total.maxToolCalls + member.budget.maxToolCalls,
        maxRecoveryActions:
          total.maxRecoveryActions + member.budget.maxRecoveryActions,
      }),
      { maxToolCalls: 0, maxRecoveryActions: 0 },
    );
    if (
      expectedMaximum.maxToolCalls !== manifest.maximumBudget.maxToolCalls ||
      expectedMaximum.maxRecoveryActions !==
        manifest.maximumBudget.maxRecoveryActions
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximumBudget"],
        message: "Run-group maximum budget must equal its frozen member sum",
      });
    }
  });

export type RunGroupManifest = z.infer<typeof runGroupManifestSchema>;
export type RunGroupMember = z.infer<typeof runGroupMemberSchema>;
export type RunGroupExclusion = z.infer<typeof runGroupExclusionSchema>;

const startedGroupPayloadSchema = z
  .object({
    phase: z.literal("started"),
    manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

const completedGroupPayloadSchema = z
  .object({ phase: z.literal("completed") })
  .strict();

const cancelledGroupPayloadSchema = z
  .object({
    phase: z.literal("cancelled"),
    reason: z.string().trim().min(1),
  })
  .strict();

export const runGroupEventPayloadSchema = z.discriminatedUnion("phase", [
  startedGroupPayloadSchema,
  completedGroupPayloadSchema,
  cancelledGroupPayloadSchema,
]);

export const runGroupEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: eventIdSchema,
    runGroupId: runGroupIdSchema,
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    actor: z.literal("ai-qa"),
    tool: z.literal("ai-qa"),
    idempotencyKey: z.string().trim().min(1),
    payload: runGroupEventPayloadSchema,
    relatedIds: z.array(runIdSchema),
  })
  .strict();

export type RunGroupEvent = z.infer<typeof runGroupEventSchema>;
