import { describe, expect, it } from "vitest";
import { runReportSchema } from "../../src/core/reports/schema.js";
import { renderRunReportMarkdown } from "../../src/services/report-generation/render-markdown.js";

describe("renderRunReportMarkdown", () => {
  it("preserves verdict classification and criterion/evidence IDs deterministically", () => {
    const report = runReportSchema.parse({
      schemaVersion: 1,
      generatedAt: "2026-07-13T00:10:00.000Z",
      project: { id: "sample-web", name: "Sample Web" },
      reportPolicy: { audience: "engineering", detail: "full" },
      run: {
        id: "run-1",
        kind: "regression",
        execution: "local",
        platform: "web",
        status: "completed",
      },
      verdict: {
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
    });

    const markdown = renderRunReportMarkdown(report);

    expect(markdown).toContain("Verdict: `pass`");
    expect(markdown).toContain("authenticated-home-visible");
    expect(markdown).toContain("evidence-home");
    expect(renderRunReportMarkdown(report)).toBe(markdown);
  });
});
