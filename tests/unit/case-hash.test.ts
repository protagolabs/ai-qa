import { describe, expect, it } from "vitest";
import { calculateCaseContentHash } from "../../src/core/cases/schema.js";

describe("calculateCaseContentHash", () => {
  it("ignores the stored contentHash field and key order", () => {
    const left = {
      schemaVersion: 1 as const,
      caseId: "login-success",
      revision: 1,
      contentHash: "sha256:old",
      title: "Login",
      promotion: { sourceRunId: "run-source", validationIssues: [] },
      acceptanceCriteria: [
        {
          id: "home-visible",
          description: "Home is visible",
          requiredEvidence: ["screenshot"],
        },
      ],
      variants: {
        web: {
          steps: [
            {
              id: "step-1-submit-login",
              sourceActionId: "event-action",
              intent: "Submit login",
              tool: "chrome-devtools-mcp" as const,
              target: {
                description: "Login button",
                stability: "stable" as const,
                stabilityRationale: "Unique data-testid owned by the fixture",
              },
              expectedState: "Home",
              assertionStrategy: "Visible home",
              evidenceCheckpoints: ["screenshot"],
            },
          ],
        },
      },
    };
    const right = { ...left, contentHash: "sha256:different" };

    expect(calculateCaseContentHash(left)).toBe(
      calculateCaseContentHash(right),
    );
  });
});
