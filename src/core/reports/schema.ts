import { z } from "zod";
import { REPORT_SCHEMA_VERSION } from "../../schemas/versions.js";
import { caseIdSchema } from "../cases/schema.js";
import {
  evidenceIdSchema,
  normalizedRelativePosixPathSchema,
} from "../evidence/schema.js";
import { controllerMatchesPlatform } from "../platforms/registry.js";
import { controllerSchema, platformSchema } from "../platforms/schema.js";
import {
  criterionIdSchema,
  eventIdSchema,
  runIdSchema,
} from "../runs/schema.js";
import {
  blockerSubtypeSchema,
  criterionResultSchema,
} from "../verdicts/schema.js";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const verdictCommon = {
  summary: z.string().trim().min(1),
  criterionResults: z.array(criterionResultSchema),
};

const reportVerdictSchema = z.discriminatedUnion("classification", [
  z.object({ classification: z.literal("pass"), ...verdictCommon }).strict(),
  z.object({ classification: z.literal("fail"), ...verdictCommon }).strict(),
  z
    .object({
      classification: z.literal("blocked"),
      ...verdictCommon,
      blockerSubtype: blockerSubtypeSchema,
    })
    .strict(),
  z
    .object({
      classification: z.literal("not_verified"),
      ...verdictCommon,
      reasonCode: z.enum([
        "budget_exhausted",
        "cancelled",
        "incomplete_coverage",
        "unknown_action",
      ]),
    })
    .strict(),
]);

export const runReportSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    project: z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
        name: z.string().trim().min(1),
      })
      .strict(),
    reportPolicy: z
      .object({
        audience: z.string().trim().min(1),
        detail: z.enum(["summary", "full"]),
      })
      .strict(),
    run: z
      .object({
        id: runIdSchema,
        kind: z.enum(["exploratory", "regression"]),
        execution: z.enum(["local", "ci"]),
        platform: platformSchema,
        controller: controllerSchema,
        status: z.enum(["completed", "cancelled"]),
      })
      .strict(),
    verdict: reportVerdictSchema,
    workOrder: z
      .object({
        goal: z.string().trim().min(1),
        acceptanceCriteria: z.array(
          z
            .object({
              id: criterionIdSchema,
              description: z.string().trim().min(1),
              requiredEvidence: z.array(z.string().trim().min(1)).min(1),
            })
            .strict(),
        ),
        evidencePolicy: z
          .object({
            screenshots: z.enum(["required", "on-failure", "optional"]),
            defaultSensitivity: z.enum(["public", "internal", "sensitive"]),
          })
          .strict(),
        pinnedCase: z
          .object({
            caseId: caseIdSchema,
            revision: z.number().int().positive(),
            caseContentHash: sha256Schema,
            platformVariantHash: sha256Schema,
          })
          .strict()
          .optional(),
      })
      .strict(),
    evidence: z.array(
      z
        .object({
          id: evidenceIdSchema,
          contentHash: sha256Schema,
          path: normalizedRelativePosixPathSchema,
          evidenceKinds: z.array(z.string().trim().min(1)).min(1),
          sourceTool: controllerSchema,
        })
        .strict(),
    ),
    timeline: z.array(
      z
        .object({
          sequence: z.number().int().positive(),
          eventId: eventIdSchema,
          type: z.enum([
            "run",
            "action",
            "observation",
            "assertion",
            "evidence",
            "decision",
            "blocker",
            "verdict",
            "recovery",
          ]),
          summary: z.string().trim().min(1),
          relatedIds: z.array(z.string().trim().min(1)),
        })
        .strict(),
    ),
    integrity: z
      .object({
        status: z.literal("verified"),
        verifiedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      !controllerMatchesPlatform(report.run.platform, report.run.controller)
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "controller"],
        message: "Report controller must match its run platform",
      });
    }
    for (const [index, evidence] of report.evidence.entries()) {
      if (evidence.sourceTool !== report.run.controller) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index, "sourceTool"],
          message: "Evidence source tool must match the report controller",
        });
      }
    }
    if (
      report.run.status === "cancelled" &&
      (report.verdict.classification !== "not_verified" ||
        report.verdict.reasonCode !== "cancelled")
    ) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "Cancelled reports require a not_verified/cancelled verdict",
      });
    }
    if (
      (report.run.kind === "regression") !==
      (report.workOrder.pinnedCase !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["workOrder", "pinnedCase"],
        message: "Only regression reports require a pinned case",
      });
    }
  });

export type RunReport = z.infer<typeof runReportSchema>;
