import { describe, expect, it } from "vitest";
import { runEventSchema, type RunEvent } from "../../src/core/runs/schema.js";

const baseEvent = {
  schemaVersion: 2 as const,
  runId: "run-schema",
  timestamp: "2026-07-13T00:00:00.000Z",
  actor: "agent" as const,
  platform: "web" as const,
  tool: "chrome-devtools-mcp",
  relatedIds: [],
};

const eventCases = [
  {
    ...baseEvent,
    id: "event-run",
    sequence: 1,
    type: "run",
    payload: {
      phase: "started",
      workOrderHash: `sha256:${"1".repeat(64)}`,
    },
  },
  {
    ...baseEvent,
    id: "event-action",
    sequence: 2,
    type: "action",
    payload: {
      phase: "planned",
      kind: "interaction",
      intent: "Submit valid credentials",
      stepId: "step-login",
      target: {
        description: "Login submit button",
        selector: '[data-testid="login"]',
      },
    },
  },
  {
    ...baseEvent,
    id: "event-observation",
    sequence: 3,
    type: "observation",
    payload: {
      summary: "Authenticated home is visible",
      state: { url: "https://example.com/home" },
      stepId: "step-login",
      actionId: "event-action",
    },
  },
  {
    ...baseEvent,
    id: "event-assertion",
    sequence: 4,
    type: "assertion",
    payload: {
      criterionId: "authenticated-home-visible",
      status: "satisfied",
      assertionKinds: ["semantic-ui"],
      actual: "Authenticated home is visible",
      expected: "Authenticated home is visible",
      observationIds: ["event-observation"],
      evidenceIds: ["evidence-login"],
      stepId: "step-login",
    },
  },
  {
    ...baseEvent,
    id: "event-evidence",
    sequence: 5,
    type: "evidence",
    payload: {
      schemaVersion: 2,
      id: "evidence-login",
      runId: "run-schema",
      projectRelativePath:
        ".ai-qa/evidence/run-schema/files/evidence-login-home.png",
      contentHash: `sha256:${"2".repeat(64)}`,
      mediaType: "image/png",
      platform: "web",
      sourceTool: "chrome-devtools-mcp",
      capturedAt: "2026-07-13T00:00:00.000Z",
      classification: "raw",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-action",
      idempotencyKey: "capture-login",
      criterionIds: ["authenticated-home-visible"],
      observationIds: ["event-observation"],
    },
  },
  {
    ...baseEvent,
    id: "event-decision",
    sequence: 6,
    type: "decision",
    payload: {
      kind: "semantic",
      rationale: "The observed page satisfies the criterion",
      relatedIds: ["event-observation"],
    },
  },
  {
    ...baseEvent,
    id: "event-blocker",
    sequence: 7,
    type: "blocker",
    payload: {
      subtype: "environment",
      condition: "The test environment is unavailable",
      attemptEventIds: ["event-action"],
      criterionIds: ["authenticated-home-visible"],
    },
  },
  {
    ...baseEvent,
    id: "event-verdict",
    sequence: 8,
    type: "verdict",
    payload: {
      classification: "pass",
      summary: "All acceptance criteria are satisfied",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: ["event-assertion"],
          evidenceIds: ["evidence-login"],
        },
      ],
    },
  },
  {
    ...baseEvent,
    id: "event-recovery",
    sequence: 9,
    type: "recovery",
    payload: {
      actionId: "event-action",
      resolution: "applied",
      observationId: "event-observation",
      rationale: "The post-action observation confirms the action applied",
    },
  },
] as const;

function readPayloadSpecificField(event: RunEvent): string {
  switch (event.type) {
    case "run":
      return event.payload.phase;
    case "action":
      return event.payload.phase;
    case "observation":
      return event.payload.summary;
    case "assertion":
      return event.payload.criterionId;
    case "evidence":
      return event.payload.id;
    case "decision":
      return event.payload.kind;
    case "blocker":
      return event.payload.subtype;
    case "verdict":
      return event.payload.classification;
    case "recovery":
      return event.payload.resolution;
  }
}

describe("runEventSchema", () => {
  it.each(eventCases)(
    "round-trips and narrows the $type event payload",
    (event) => {
      const parsed = runEventSchema.parse(event);

      expect(parsed).toEqual(event);
      expect(readPayloadSpecificField(parsed)).toBeTruthy();
    },
  );

  it("parses an event in the existing 0.1.0 disk format", () => {
    const existingEvent = {
      schemaVersion: 2,
      id: "event-existing",
      runId: "run-existing",
      sequence: 1,
      timestamp: "2026-07-13T00:00:00.000Z",
      actor: "agent",
      platform: "web",
      tool: "custom-0.1.0-controller",
      type: "action",
      idempotencyKey: "existing-action",
      payload: {
        phase: "planned",
        kind: "interaction",
        intent: "Exercise the existing controller",
        stepId: "step-existing",
        target: { description: "Existing target" },
      },
      relatedIds: ["event-prior"],
    };

    expect(runEventSchema.parse(existingEvent)).toEqual(existingEvent);
  });

  it("rejects an action event carrying an observation payload", () => {
    const mismatchedEvent = {
      ...baseEvent,
      id: "event-mismatched",
      sequence: 10,
      type: "action",
      payload: {
        summary: "This is an observation payload",
        state: { visible: true },
        actionId: "event-action",
      },
    };

    expect(runEventSchema.safeParse(mismatchedEvent).success).toBe(false);
  });
});
