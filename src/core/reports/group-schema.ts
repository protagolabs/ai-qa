import { z } from "zod";
import { REPORT_SCHEMA_VERSION } from "../../schemas/versions.js";
import { caseIdSchema } from "../cases/schema.js";
import { platformSchema } from "../platforms/schema.js";
import { runGroupIdSchema } from "../run-groups/schema.js";
import { runIdSchema } from "../runs/schema.js";
import { blockerSubtypeSchema } from "../verdicts/schema.js";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

const matrixIdentity = {
  caseId: caseIdSchema,
  revision: z.number().int().positive(),
  caseContentHash: sha256Schema,
  platform: platformSchema,
};

const memberIdentity = { ...matrixIdentity, runId: runIdSchema };

export const runGroupReportCellSchema = z.discriminatedUnion("status", [
  z.object({ ...memberIdentity, status: z.literal("pass") }).strict(),
  z.object({ ...memberIdentity, status: z.literal("fail") }).strict(),
  z
    .object({
      ...memberIdentity,
      status: z.literal("blocked"),
      blockerSubtype: blockerSubtypeSchema,
    })
    .strict(),
  z
    .object({
      ...memberIdentity,
      status: z.literal("not_verified"),
      reasonCode: z.enum([
        "budget_exhausted",
        "cancelled",
        "incomplete_coverage",
        "unknown_action",
      ]),
    })
    .strict(),
  z
    .object({
      ...matrixIdentity,
      status: z.literal("coverage_gap"),
      reason: z.literal("missing_variant"),
    })
    .strict(),
]);

export const runGroupReportSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    generatedAt: z.string().datetime(),
    project: z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
        name: z.string().trim().min(1),
      })
      .strict(),
    reportPolicy: z
      .object({
        audience: z.string().trim().min(1),
        detail: z.enum(["summary", "full"]),
      })
      .strict(),
    group: z
      .object({
        id: runGroupIdSchema,
        execution: z.enum(["local", "ci"]),
        status: z.enum(["completed", "cancelled"]),
        selectionMode: z.enum(["explicit", "all-active"]),
        selectedPlatforms: z.array(platformSchema).min(1),
        createdAt: z.string().datetime(),
      })
      .strict(),
    matrix: z.array(runGroupReportCellSchema).min(1),
    summary: z
      .object({
        pass: z.number().int().nonnegative(),
        fail: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        notVerified: z.number().int().nonnegative(),
        coverageGap: z.number().int().nonnegative(),
      })
      .strict(),
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
      new Set(report.group.selectedPlatforms).size !==
      report.group.selectedPlatforms.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["group", "selectedPlatforms"],
        message: "Selected report platforms must be unique",
      });
    }
    const cells = report.matrix.map(
      (cell) => `${cell.caseId}\u0000${cell.platform}`,
    );
    if (new Set(cells).size !== cells.length) {
      context.addIssue({
        code: "custom",
        path: ["matrix"],
        message: "Aggregate matrix cells must be unique",
      });
    }
    if (
      report.matrix.some(
        (cell) => !report.group.selectedPlatforms.includes(cell.platform),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["matrix"],
        message: "Every aggregate cell must use a selected platform",
      });
    }
    const caseCells = new Map<string, typeof report.matrix>();
    for (const cell of report.matrix) {
      const entries = caseCells.get(cell.caseId) ?? [];
      entries.push(cell);
      caseCells.set(cell.caseId, entries);
    }
    for (const [caseId, entries] of caseCells) {
      const identity = entries[0];
      if (
        identity === undefined ||
        entries.some(
          (entry) =>
            entry.revision !== identity.revision ||
            entry.caseContentHash !== identity.caseContentHash,
        ) ||
        report.group.selectedPlatforms.some(
          (platform) => !entries.some((entry) => entry.platform === platform),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["matrix"],
          message: `Case ${caseId} must contain one immutable cell per selected platform`,
        });
      }
    }
    const expected = report.matrix.reduce(
      (summary, cell) => {
        switch (cell.status) {
          case "pass":
            summary.pass += 1;
            break;
          case "fail":
            summary.fail += 1;
            break;
          case "blocked":
            summary.blocked += 1;
            break;
          case "not_verified":
            summary.notVerified += 1;
            break;
          case "coverage_gap":
            summary.coverageGap += 1;
            break;
        }
        return summary;
      },
      { pass: 0, fail: 0, blocked: 0, notVerified: 0, coverageGap: 0 },
    );
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (report.summary[key] !== expected[key]) {
        context.addIssue({
          code: "custom",
          path: ["summary", key],
          message: "Aggregate summary must equal the matrix counts",
        });
      }
    }
  });

export type RunGroupReportCell = z.infer<typeof runGroupReportCellSchema>;
export type RunGroupReport = z.infer<typeof runGroupReportSchema>;
