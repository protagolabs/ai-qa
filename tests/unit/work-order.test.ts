import { describe, expect, it } from "vitest";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  runIdSchema,
  workOrderSchema,
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
    expect(Object.isFrozen(workOrder.acceptanceCriteria)).toBe(true);
    expect(Object.isFrozen(workOrder.acceptanceCriteria[0])).toBe(true);
    expect(
      Object.isFrozen(workOrder.acceptanceCriteria[0]?.requiredEvidence),
    ).toBe(true);
    expect(Object.isFrozen(workOrder.readiness)).toBe(true);
    expect(Object.isFrozen(workOrder.readiness.checks)).toBe(true);
    expect(Object.isFrozen(workOrder.evidencePolicy)).toBe(true);
    expect(Object.isFrozen(workOrder.budget)).toBe(true);
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

  it("trims goals and rejects whitespace-only goals in every work-order schema", () => {
    const input = exploratoryRunInputSchema.parse({
      goal: "  Verify login  ",
      acceptanceCriteria: [
        { id: "home", description: "Home", requiredEvidence: ["screenshot"] },
      ],
      readiness: { platform: "web", status: "ready", checks: [] },
    });
    expect(input.goal).toBe("Verify login");

    expect(() =>
      exploratoryRunInputSchema.parse({ ...input, goal: "   " }),
    ).toThrow();
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
    expect(() =>
      workOrderSchema.parse({ ...workOrder, goal: "   " }),
    ).toThrow();
  });

  it("rejects unsafe run IDs and unknown persisted work-order fields", () => {
    expect(runIdSchema.parse("run-1")).toBe("run-1");
    for (const unsafe of [
      ".",
      "..",
      "../outside",
      "..\\outside",
      "/tmp/run-1",
    ]) {
      expect(() => runIdSchema.parse(unsafe)).toThrow();
    }

    const input = exploratoryRunInputSchema.parse({
      goal: "Verify login",
      acceptanceCriteria: [
        { id: "home", description: "Home", requiredEvidence: ["screenshot"] },
      ],
      readiness: { platform: "web", status: "ready", checks: [] },
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
    expect(() =>
      workOrderSchema.parse({
        ...workOrder,
        evidencePolicy: { ...workOrder.evidencePolicy, unexpected: true },
      }),
    ).toThrow();
  });
});
