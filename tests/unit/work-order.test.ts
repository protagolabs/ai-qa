import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256Canonical,
} from "../../src/core/canonical-json.js";
import {
  createExploratoryWorkOrder,
  effectiveWorkOrderRecordingMode,
  exploratoryRunInputSchema,
  runIdSchema,
  workOrderSchema,
} from "../../src/core/runs/schema.js";
import { projectConfigV2 } from "../helpers/project-fixture.js";

describe("exploratory work orders", () => {
  it("preserves legacy bytes and hashes while deriving local-only recording", () => {
    const legacy = {
      schemaVersion: 1,
      protocolVersion: "1.0.0",
      runId: "run-legacy",
      kind: "exploratory",
      execution: "local",
      projectId: "sample-web",
      platform: "web",
      startedAt: "2026-07-13T00:00:00.000Z",
      goal: "Verify successful login",
      acceptanceCriteria: [
        {
          id: "authenticated-home-visible",
          description: "Authenticated home is visible",
          requiredEvidence: ["post-action-screenshot"],
        },
      ],
      requiredSteps: [],
      readiness: { platform: "web", status: "ready", checks: [] },
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      budget: {
        maxToolCalls: 100,
        maxRecoveryActions: 10,
        deadline: "2026-07-13T00:30:00.000Z",
      },
    };
    const bytes = canonicalJson(legacy);
    const hash = sha256Canonical(legacy);

    const parsed = workOrderSchema.parse(legacy);

    expect(canonicalJson(parsed)).toBe(bytes);
    expect(sha256Canonical(parsed)).toBe(hash);
    expect(parsed).not.toHaveProperty("recordingPolicy");
    expect(effectiveWorkOrderRecordingMode(parsed)).toBe("local-only");
  });

  it("snapshots the config recording mode in new work orders", () => {
    const config = projectConfigV2("project-skill");
    const input = exploratoryRunInputSchema.parse({
      goal: "Verify successful login",
      acceptanceCriteria: [
        {
          id: "authenticated-home-visible",
          description: "Authenticated home is visible",
          requiredEvidence: ["post-action-screenshot"],
        },
      ],
      readiness: { platform: "web", status: "ready", checks: [] },
    });
    const workOrder = createExploratoryWorkOrder({
      projectId: config.project.id,
      runId: "run-1",
      input,
      evidencePolicy: {
        screenshots: config.evidencePolicy.screenshots,
        defaultSensitivity: config.evidencePolicy.defaultSensitivity,
      },
      recordingPolicy: config.recordingPolicy,
      startedAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    config.recordingPolicy.mode = "local-only";

    expect(effectiveWorkOrderRecordingMode(workOrder)).toBe("project-skill");
    expect(Object.isFrozen(workOrder.recordingPolicy)).toBe(true);
  });

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

  it("keeps non-exploratory work orders available for future regression execution", () => {
    const input = exploratoryRunInputSchema.parse({
      goal: "Verify login",
      acceptanceCriteria: [
        { id: "home", description: "Home", requiredEvidence: ["screenshot"] },
      ],
      readiness: { platform: "web", status: "ready", checks: [] },
    });
    const exploratory = createExploratoryWorkOrder({
      projectId: "sample-web",
      runId: "run-1",
      input,
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      startedAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    expect(
      workOrderSchema.parse({
        ...exploratory,
        kind: "regression",
        execution: "ci",
        requiredSteps: [
          {
            id: "step-login",
            order: 0,
            intent: "Submit login",
            tool: "chrome-devtools-mcp",
            target: {
              description: "Login button",
              stability: "stable",
              stabilityRationale: "Unique application-owned target",
            },
            expectedState: "Home is visible",
            assertionStrategy: "Observe the home page",
            evidenceCheckpoints: ["screenshot"],
          },
        ],
        pinnedCase: {
          caseId: "login-success",
          revision: 1,
          caseContentHash: `sha256:${"a".repeat(64)}`,
          platformVariantHash: `sha256:${"b".repeat(64)}`,
        },
        budget: {
          maxToolCalls: 25,
          maxRecoveryActions: 2,
          deadline: "2026-07-13T02:00:00.000Z",
        },
      }),
    ).toMatchObject({ kind: "regression", execution: "ci" });
  });
});
