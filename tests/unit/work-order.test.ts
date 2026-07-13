import { describe, expect, it } from "vitest";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";

describe("exploratory work orders", () => {
  it("requires stable criterion IDs and freezes finite defaults", () => {
    const input = exploratoryRunInputSchema.parse({
      goal: "Verify successful login",
      acceptanceCriteria: [
        {
          id: "authenticated-home-visible",
          description: "Authenticated home is visible",
          requiredEvidence: ["post-action-screenshot"],
        },
      ],
      readiness: {
        platform: "web",
        status: "ready",
        checks: [],
      },
    });

    const workOrder = createExploratoryWorkOrder({
      projectId: "sample-web",
      runId: "run-1",
      input,
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      startedAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    expect(workOrder.budget).toEqual({
      maxToolCalls: 100,
      maxRecoveryActions: 10,
      deadline: "2026-07-13T00:30:00.000Z",
    });
    expect(Object.isFrozen(workOrder)).toBe(true);
  });

  it("rejects duplicate criterion IDs", () => {
    expect(() =>
      exploratoryRunInputSchema.parse({
        goal: "Verify login",
        acceptanceCriteria: [
          { id: "home", description: "Home", requiredEvidence: ["screenshot"] },
          { id: "home", description: "Account", requiredEvidence: ["text"] },
        ],
        readiness: { platform: "web", status: "ready", checks: [] },
      }),
    ).toThrow();
  });
});
