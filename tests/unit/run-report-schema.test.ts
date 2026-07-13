import { describe, expect, it } from "vitest";
import { runReportSchema } from "../../src/core/reports/schema.js";

function report(status: "completed" | "cancelled" = "completed") {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-13T00:10:00.000Z",
    project: { id: "sample-web", name: "Sample Web" },
    reportPolicy: { audience: "engineering", detail: "full" },
    run: {
      id: "run-1",
      kind: "regression",
      execution: "local",
      platform: "web",
      status,
    },
    verdict:
      status === "cancelled"
        ? {
            classification: "not_verified",
            summary: "Stopped by the user",
            criterionResults: [],
            reasonCode: "cancelled",
          }
        : {
            classification: "pass",
            summary: "Login verified",
            criterionResults: [
              {
                criterionId: "authenticated-home-visible",
                status: "satisfied",
                assertionIds: ["event-assertion"],
                evidenceIds: ["evidence-home"],
              },
            ],
          },
    workOrder: {
      goal: "Verify login",
      acceptanceCriteria: [
        {
          id: "authenticated-home-visible",
          description: "Authenticated home is visible",
          requiredEvidence: ["post-action-screenshot"],
        },
      ],
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      pinnedCase: {
        caseId: "login-success",
        revision: 1,
        caseContentHash: `sha256:${"b".repeat(64)}`,
        platformVariantHash: `sha256:${"c".repeat(64)}`,
      },
    },
    evidence: [
      {
        id: "evidence-home",
        contentHash: `sha256:${"a".repeat(64)}`,
        path: ".ai-qa/evidence/run-1/files/evidence-home-home.png",
        evidenceKinds: ["post-action-screenshot"],
      },
    ],
    timeline: [
      {
        sequence: 1,
        eventId: "event-observation",
        type: "observation",
        summary: "Authenticated home is visible",
        relatedIds: ["evidence-home"],
      },
    ],
    integrity: {
      status: "verified",
      verifiedAt: "2026-07-13T00:10:00.000Z",
    },
  };
}

describe("runReportSchema", () => {
  it("accepts completed and cancelled terminal run reports", () => {
    expect(runReportSchema.parse(report()).run.status).toBe("completed");
    expect(runReportSchema.parse(report("cancelled")).run.status).toBe(
      "cancelled",
    );
  });

  it("rejects non-terminal status and unknown nested fields", () => {
    expect(() =>
      runReportSchema.parse({
        ...report(),
        run: { ...report().run, status: "running" },
      }),
    ).toThrow();
    expect(() =>
      runReportSchema.parse({
        ...report(),
        project: { ...report().project, unexpected: true },
      }),
    ).toThrow();
  });
});
