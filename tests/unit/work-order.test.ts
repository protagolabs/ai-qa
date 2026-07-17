import { describe, expect, it } from "vitest";
import { controllerForPlatform } from "../../src/core/platforms/registry.js";
import type { Platform } from "../../src/core/platforms/schema.js";
import {
  createExploratoryWorkOrder,
  effectiveWorkOrderRecordingMode,
  exploratoryRunInputSchema,
  runIdSchema,
  storedWorkProtocolVersionSchema,
  workOrderSchema,
} from "../../src/core/runs/schema.js";
import { projectConfig } from "../helpers/project-fixture.js";

const evidencePolicy = {
  screenshots: "required" as const,
  defaultSensitivity: "internal" as const,
};
const startedAt = new Date("2026-07-13T00:00:00.000Z");

function exploratoryInput(platform: Platform) {
  return exploratoryRunInputSchema.parse({
    goal: "Verify successful login",
    acceptanceCriteria: [
      {
        id: "authenticated-home-visible",
        description: "Authenticated home is visible",
        requiredEvidence: ["post-action-screenshot"],
      },
    ],
    readiness: { platform, status: "ready", checks: [] },
  });
}

describe("exploratory work orders", () => {
  const projectSkill = {
    path: ".agents/skills/ai-qa-project/SKILL.md" as const,
    contentSha256: "a".repeat(64),
  };

  it.each([
    ["web", "chrome-devtools-mcp"],
    ["ios-simulator", "pepper"],
    ["android-emulator", "appium"],
  ] as const)("audits %s with %s", (platform, controller) => {
    const workOrder = createExploratoryWorkOrder({
      platform,
      projectId: "sample-project",
      runId: `run-${platform}`,
      input: exploratoryInput(platform),
      evidencePolicy,
      recordingPolicy: { mode: "local-only" },
      startedAt,
    });

    expect(workOrder.platform).toBe(platform);
    expect(workOrder.readiness.platform).toBe(platform);
    expect(controllerForPlatform(workOrder.platform)).toBe(controller);
    expect(workOrder.protocolVersion).toBe("2.0.0");
    expect(workOrder.schemaVersion).toBe(2);
  });

  it("accepts only the current stored work protocol", () => {
    expect(storedWorkProtocolVersionSchema.parse("2.0.0")).toBe("2.0.0");
    for (const legacy of ["1.0.0", "1.1.0", "1.2.0"]) {
      expect(() => storedWorkProtocolVersionSchema.parse(legacy)).toThrow();
    }
  });

  it("rejects readiness and required-step controllers that mismatch the run platform", () => {
    const workOrder = createExploratoryWorkOrder({
      platform: "ios-simulator",
      projectId: "sample-project",
      runId: "run-ios",
      input: exploratoryInput("ios-simulator"),
      evidencePolicy,
      startedAt,
    });

    expect(() =>
      workOrderSchema.parse({
        ...workOrder,
        readiness: { ...workOrder.readiness, platform: "web" },
      }),
    ).toThrow("Readiness must match run platform");
    expect(() =>
      workOrderSchema.parse({
        ...workOrder,
        kind: "regression",
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
            assertionStrategy: "Observe the home screen",
            evidenceCheckpoints: ["screenshot"],
          },
        ],
        pinnedCase: {
          caseId: "login-success",
          revision: 1,
          caseContentHash: `sha256:${"a".repeat(64)}`,
          platformVariantHash: `sha256:${"b".repeat(64)}`,
        },
      }),
    ).toThrow("Step controller must match run platform");
  });

  it("snapshots the config recording mode in new work orders", () => {
    const config = projectConfig(["web"], "project-skill");
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
      platform: "web",
      projectId: config.project.id,
      runId: "run-1",
      input,
      evidencePolicy: {
        screenshots: config.evidencePolicy.screenshots,
        defaultSensitivity: config.evidencePolicy.defaultSensitivity,
      },
      recordingPolicy: config.recordingPolicy,
      projectSkill,
      startedAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    config.recordingPolicy.mode = "local-only";

    expect(workOrder.protocolVersion).toBe("2.0.0");
    expect(effectiveWorkOrderRecordingMode(workOrder)).toBe("project-skill");
    expect(workOrder.projectSkill).toEqual(projectSkill);
    expect(Object.isFrozen(workOrder.recordingPolicy)).toBe(true);
    expect(Object.isFrozen(workOrder.projectSkill)).toBe(true);
  });

  it("requires a snapshot for new project-skill work orders", () => {
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
      platform: "web",
      projectId: "sample-web",
      runId: "run-local",
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
        recordingPolicy: { mode: "project-skill" },
      }),
    ).toThrow();
  });

  it("forbids a project Skill snapshot for local-only work orders", () => {
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
      platform: "web",
      projectId: "sample-web",
      runId: "run-local",
      input,
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      startedAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    expect(() =>
      workOrderSchema.parse({ ...workOrder, projectSkill }),
    ).toThrow();
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
      platform: "web",
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
      platform: "web",
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
      platform: "web",
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
      platform: "web",
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
