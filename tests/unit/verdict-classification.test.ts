import { describe, expect, it } from "vitest";
import {
  blockerPayloadSchema,
  verdictPayloadSchema,
} from "../../src/core/verdicts/schema.js";

describe("verdictPayloadSchema", () => {
  it("requires a subtype and blocker IDs for blocked", () => {
    expect(() =>
      verdictPayloadSchema.parse({
        classification: "blocked",
        summary: "Screenshot capture failed",
        criterionResults: [],
      }),
    ).toThrow();
  });

  it("keeps not_verified distinct from blocked evidence", () => {
    expect(
      verdictPayloadSchema.parse({
        classification: "not_verified",
        reasonCode: "budget_exhausted",
        summary: "The work-order budget ended before all criteria were checked",
        criterionResults: [],
      }).classification,
    ).toBe("not_verified");
  });

  it("strictly validates stable criterion, evidence, and blocker IDs", () => {
    expect(() =>
      verdictPayloadSchema.parse({
        classification: "pass",
        summary: "Invalid citation",
        criterionResults: [
          {
            criterionId: "criterion",
            status: "satisfied",
            assertionIds: ["not-an-event"],
            evidenceIds: [],
          },
        ],
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      blockerPayloadSchema.parse({
        subtype: "tool",
        condition: "Tool failed",
        attemptEventIds: [],
        criterionIds: [],
      }),
    ).toThrow();
  });
});
