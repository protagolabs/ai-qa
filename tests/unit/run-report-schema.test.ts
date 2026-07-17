import { describe, expect, it } from "vitest";
import { controllerForPlatform } from "../../src/core/platforms/registry.js";
import type { Platform } from "../../src/core/platforms/schema.js";
import { runReportSchema } from "../../src/core/reports/schema.js";
import { REPORT_SCHEMA_VERSION } from "../../src/schemas/versions.js";

function report(
  status: "completed" | "cancelled" = "completed",
  platform: Platform = "web",
) {
  const controller = controllerForPlatform(platform);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: "2026-07-13T00:10:00.000Z",
    project: { id: "sample-web", name: "Sample Web" },
    reportPolicy: { audience: "engineering", detail: "full" },
    run: {
      id: "run-1",
      kind: "regression",
      execution: "local",
      platform,
      controller,
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
        sourceTool: controller,
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

  it.each(["web", "ios-simulator", "android-emulator"] as const)(
    "accepts matching %s platform, controller, and evidence provenance",
    (platform) => {
      const parsed = runReportSchema.parse(report("completed", platform));

      expect(parsed.run).toMatchObject({
        platform,
        controller: controllerForPlatform(platform),
      });
      expect(parsed.evidence[0]?.sourceTool).toBe(parsed.run.controller);
    },
  );

  it("rejects mismatched run and evidence controllers", () => {
    expect(() =>
      runReportSchema.parse({
        ...report(),
        run: { ...report().run, controller: "pepper" },
      }),
    ).toThrow();
    expect(() =>
      runReportSchema.parse({
        ...report(),
        evidence: [{ ...report().evidence[0], sourceTool: "pepper" }],
      }),
    ).toThrow();
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
