import { describe, expect, it } from "vitest";
import { runEventSchema, type RunEvent } from "../../src/core/runs/schema.js";
import type { VerdictPayload } from "../../src/core/verdicts/schema.js";
import { validatePassEvidenceFreshness } from "../../src/services/run-protocol/evidence-semantics.js";

function event(
  sequence: number,
  id: string,
  type: RunEvent["type"],
  payload: unknown,
): RunEvent {
  return runEventSchema.parse({
    schemaVersion: 2,
    id,
    runId: "run-1",
    sequence,
    timestamp: new Date(sequence * 1_000).toISOString(),
    actor: type === "evidence" ? "ai-qa" : "agent",
    platform: "web",
    tool:
      type === "evidence" || type === "assertion"
        ? "ai-qa"
        : "chrome-devtools-mcp",
    type,
    payload,
    relatedIds: [],
  });
}

function plannedAction(
  sequence: number,
  id: string,
  kind: "interaction" | "observation" | "evidence-capture",
  stepId: string,
): RunEvent {
  return event(sequence, id, "action", {
    phase: "planned",
    kind,
    intent: `${kind} for ${stepId}`,
    stepId,
    target: { description: `${kind} target` },
  });
}

function completedAction(
  sequence: number,
  id: string,
  actionId: string,
): RunEvent {
  return event(sequence, id, "action", {
    phase: "completed",
    actionId,
    toolResult: { summary: `${actionId} completed` },
  });
}

function observation(
  sequence: number,
  id: string,
  actionId: string,
  stepId: string,
): RunEvent {
  return event(sequence, id, "observation", {
    summary: `Observed ${stepId}`,
    state: { visible: true },
    stepId,
    actionId,
  });
}

function evidence(
  sequence: number,
  id: string,
  captureActionId: string,
  observationIds: string[],
): RunEvent {
  return event(sequence, `event-${id}`, "evidence", {
    schemaVersion: 2,
    id,
    runId: "run-1",
    projectRelativePath: `.ai-qa/evidence/run-1/files/${id}-screen.png`,
    contentHash: `sha256:${"0".repeat(64)}`,
    mediaType: "image/png",
    platform: "web",
    sourceTool: "chrome-devtools-mcp",
    capturedAt: new Date(sequence * 1_000).toISOString(),
    classification: "raw",
    sensitivity: "internal",
    evidenceKinds: ["post-action-screenshot"],
    captureActionId,
    idempotencyKey: `capture-${id}`,
    criterionIds: ["authenticated-home-visible"],
    observationIds,
  });
}

function assertion(
  sequence: number,
  id: string,
  stepId: string,
  observationIds: string[],
  evidenceIds: string[],
): RunEvent {
  return event(sequence, id, "assertion", {
    criterionId: "authenticated-home-visible",
    status: "satisfied",
    assertionKinds: ["semantic-ui"],
    actual: "Authenticated home is visible",
    expected: "Authenticated home is visible",
    observationIds,
    evidenceIds,
    stepId,
  });
}

function pass(assertionId: string, evidenceId: string): VerdictPayload {
  return {
    classification: "pass",
    summary: "Login verified",
    criterionResults: [
      {
        criterionId: "authenticated-home-visible",
        status: "satisfied",
        assertionIds: [assertionId],
        evidenceIds: [evidenceId],
      },
    ],
  };
}

describe("validatePassEvidenceFreshness", () => {
  it("rejects evidence captured before its asserted interaction", () => {
    const events = [
      plannedAction(1, "event-observe", "observation", "step-initial"),
      completedAction(2, "event-observe-complete", "event-observe"),
      observation(3, "event-observation", "event-observe", "step-initial"),
      plannedAction(4, "event-capture", "evidence-capture", "step-initial"),
      completedAction(5, "event-capture-complete", "event-capture"),
      evidence(6, "evidence-old", "event-capture", ["event-observation"]),
      plannedAction(7, "event-submit", "interaction", "step-submit"),
      completedAction(8, "event-submit-complete", "event-submit"),
      assertion(
        9,
        "event-assertion",
        "step-submit",
        ["event-observation"],
        ["evidence-old"],
      ),
    ];

    expect(() =>
      validatePassEvidenceFreshness(
        events,
        pass("event-assertion", "evidence-old"),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "verdict.stale_post_action_evidence" }),
    );
  });

  it("accepts observation and completed capture after the asserted interaction", () => {
    const events = [
      plannedAction(1, "event-submit", "interaction", "step-submit"),
      completedAction(2, "event-submit-complete", "event-submit"),
      plannedAction(3, "event-observe", "observation", "step-submit"),
      completedAction(4, "event-observe-complete", "event-observe"),
      observation(5, "event-observation", "event-observe", "step-submit"),
      plannedAction(6, "event-capture", "evidence-capture", "step-submit"),
      completedAction(7, "event-capture-complete", "event-capture"),
      evidence(8, "evidence-home", "event-capture", ["event-observation"]),
      assertion(
        9,
        "event-assertion",
        "step-submit",
        ["event-observation"],
        ["evidence-home"],
      ),
    ];

    expect(() =>
      validatePassEvidenceFreshness(
        events,
        pass("event-assertion", "evidence-home"),
      ),
    ).not.toThrow();
  });

  it("ignores a later completed interaction for an unrelated step", () => {
    const events = [
      plannedAction(1, "event-submit", "interaction", "step-submit"),
      completedAction(2, "event-submit-complete", "event-submit"),
      plannedAction(3, "event-observe", "observation", "step-submit"),
      completedAction(4, "event-observe-complete", "event-observe"),
      observation(5, "event-observation", "event-observe", "step-submit"),
      plannedAction(6, "event-capture", "evidence-capture", "step-submit"),
      completedAction(7, "event-capture-complete", "event-capture"),
      evidence(8, "evidence-home", "event-capture", ["event-observation"]),
      plannedAction(9, "event-help", "interaction", "step-help"),
      completedAction(10, "event-help-complete", "event-help"),
      assertion(
        11,
        "event-assertion",
        "step-submit",
        ["event-observation"],
        ["evidence-home"],
      ),
    ];

    expect(() =>
      validatePassEvidenceFreshness(
        events,
        pass("event-assertion", "evidence-home"),
      ),
    ).not.toThrow();
  });

  it("rejects proof made stale by a later completed interaction on the asserted step", () => {
    const events = [
      plannedAction(1, "event-submit", "interaction", "step-submit"),
      completedAction(2, "event-submit-complete", "event-submit"),
      plannedAction(3, "event-observe", "observation", "step-submit"),
      completedAction(4, "event-observe-complete", "event-observe"),
      observation(5, "event-observation", "event-observe", "step-submit"),
      plannedAction(6, "event-capture", "evidence-capture", "step-submit"),
      completedAction(7, "event-capture-complete", "event-capture"),
      evidence(8, "evidence-home", "event-capture", ["event-observation"]),
      plannedAction(9, "event-submit-again", "interaction", "step-submit"),
      completedAction(10, "event-submit-again-complete", "event-submit-again"),
      assertion(
        11,
        "event-assertion",
        "step-submit",
        ["event-observation"],
        ["evidence-home"],
      ),
    ];

    expect(() =>
      validatePassEvidenceFreshness(
        events,
        pass("event-assertion", "evidence-home"),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "verdict.stale_post_action_evidence" }),
    );
  });

  it("rejects verdict evidence that is not cited by a verdict assertion", () => {
    const events = [
      plannedAction(1, "event-observe", "observation", "step-observe"),
      completedAction(2, "event-observe-complete", "event-observe"),
      observation(3, "event-observation", "event-observe", "step-observe"),
      plannedAction(4, "event-capture", "evidence-capture", "step-observe"),
      completedAction(5, "event-capture-complete", "event-capture"),
      evidence(6, "evidence-home", "event-capture", ["event-observation"]),
      assertion(
        7,
        "event-assertion",
        "step-observe",
        ["event-observation"],
        [],
      ),
    ];

    expect(() =>
      validatePassEvidenceFreshness(
        events,
        pass("event-assertion", "evidence-home"),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "verdict.stale_post_action_evidence" }),
    );
  });

  it("rejects evidence emitted before its capture action completes", () => {
    const events = [
      plannedAction(1, "event-observe", "observation", "step-observe"),
      completedAction(2, "event-observe-complete", "event-observe"),
      observation(3, "event-observation", "event-observe", "step-observe"),
      plannedAction(4, "event-capture", "evidence-capture", "step-observe"),
      evidence(5, "evidence-home", "event-capture", ["event-observation"]),
      completedAction(6, "event-capture-complete", "event-capture"),
      assertion(
        7,
        "event-assertion",
        "step-observe",
        ["event-observation"],
        ["evidence-home"],
      ),
    ];

    expect(() =>
      validatePassEvidenceFreshness(
        events,
        pass("event-assertion", "evidence-home"),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "verdict.stale_post_action_evidence" }),
    );
  });

  it("preserves observation and completed capture flows without an interaction", () => {
    const events = [
      plannedAction(1, "event-observe", "observation", "step-observe"),
      completedAction(2, "event-observe-complete", "event-observe"),
      observation(3, "event-observation", "event-observe", "step-observe"),
      plannedAction(4, "event-capture", "evidence-capture", "step-observe"),
      completedAction(5, "event-capture-complete", "event-capture"),
      evidence(6, "evidence-home", "event-capture", ["event-observation"]),
      assertion(
        7,
        "event-assertion",
        "step-observe",
        ["event-observation"],
        ["evidence-home"],
      ),
    ];

    expect(() =>
      validatePassEvidenceFreshness(
        events,
        pass("event-assertion", "evidence-home"),
      ),
    ).not.toThrow();
  });
});
