import { describe, expect, it } from "vitest";
import {
  calculateCaseContentHash,
  calculatePlatformVariantHash,
  caseRevisionSchema,
  type CaseRevision,
} from "../../src/core/cases/schema.js";
import { CASE_SCHEMA_VERSION } from "../../src/schemas/versions.js";

describe("calculateCaseContentHash", () => {
  it("ignores the stored contentHash field and key order", () => {
    const left = {
      schemaVersion: CASE_SCHEMA_VERSION,
      caseId: "login-success",
      revision: 1,
      contentHash: "sha256:old",
      title: "Login",
      promotion: {
        sources: { web: { sourceRunId: "run-source" } },
        validationIssues: [],
      },
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

    expect(caseRevisionSchema.safeParse(left).success).toBe(true);
    expect(
      caseRevisionSchema.safeParse({ ...left, schemaVersion: 1 }).success,
    ).toBe(false);
    expect(calculateCaseContentHash(left)).toBe(
      calculateCaseContentHash(right),
    );
  });

  it("hashes only the selected immutable platform variant", () => {
    const revision = {
      schemaVersion: CASE_SCHEMA_VERSION,
      caseId: "login-success",
      revision: 2,
      contentHash: "sha256:case",
      title: "Login",
      promotion: {
        sources: {
          web: { sourceRunId: "run-web-source" },
          "ios-simulator": { sourceRunId: "run-ios-source" },
        },
        validationIssues: [],
      },
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
              sourceActionId: "event-web-action",
              intent: "Submit login",
              tool: "chrome-devtools-mcp",
              target: {
                description: "Login button",
                stability: "stable",
                stabilityRationale: "Stable Web control",
              },
              expectedState: "Home",
              assertionStrategy: "Visible home",
              evidenceCheckpoints: ["screenshot"],
            },
          ],
        },
        "ios-simulator": {
          steps: [
            {
              id: "step-1-submit-login",
              sourceActionId: "event-ios-action",
              intent: "Submit login",
              tool: "pepper",
              target: {
                description: "Login button",
                stability: "stable",
                stabilityRationale: "Stable accessibility identifier",
              },
              expectedState: "Home",
              assertionStrategy: "Visible home",
              evidenceCheckpoints: ["screenshot"],
            },
          ],
        },
      },
    } satisfies CaseRevision;
    const changedIos = structuredClone(revision);
    changedIos.variants["ios-simulator"].steps[0]!.intent = "Updated login";

    expect(calculatePlatformVariantHash(revision, "web")).toBe(
      calculatePlatformVariantHash(changedIos, "web"),
    );
    expect(calculatePlatformVariantHash(revision, "ios-simulator")).not.toBe(
      calculatePlatformVariantHash(changedIos, "ios-simulator"),
    );
  });

  it("rejects a hash request for a missing platform variant", () => {
    const revision = {
      schemaVersion: CASE_SCHEMA_VERSION,
      caseId: "login-success",
      revision: 1,
      contentHash: "sha256:case",
      title: "Login",
      promotion: {
        sources: { web: { sourceRunId: "run-web-source" } },
        validationIssues: [],
      },
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
              sourceActionId: "event-web-action",
              intent: "Submit login",
              tool: "chrome-devtools-mcp",
              target: {
                description: "Login button",
                stability: "stable",
                stabilityRationale: "Stable Web control",
              },
              expectedState: "Home",
              assertionStrategy: "Visible home",
              evidenceCheckpoints: ["screenshot"],
            },
          ],
        },
      },
    } satisfies CaseRevision;

    expect(() =>
      calculatePlatformVariantHash(revision, "ios-simulator"),
    ).toThrow(
      expect.objectContaining({
        code: "case.variant_missing",
      }),
    );
  });
});
