import { describe, expect, it, vi } from "vitest";
import { sha256Canonical } from "../../src/core/canonical-json.js";
import { validateEvidenceParity } from "../../src/core/evidence/parity.js";
import {
  evidenceRecordSchema,
  type EvidenceRecord,
} from "../../src/core/evidence/schema.js";
import {
  actionPayloadSchema,
  assertionPayloadSchema,
  decisionPayloadSchema,
  evidenceEventPayloadSchema,
  observationPayloadSchema,
  recoveryPayloadSchema,
} from "../../src/core/runs/event-payloads.js";
import {
  lifecyclePayloadSchema,
  validateRunLifecycleHistory,
} from "../../src/core/runs/lifecycle.js";
import {
  runEventSchema,
  workOrderSchema,
  type RunEvent,
  type WorkOrder,
} from "../../src/core/runs/schema.js";
import {
  blockerPayloadSchema,
  verdictPayloadSchema,
} from "../../src/core/verdicts/schema.js";
import { validatePassEvidenceFreshness } from "../../src/services/run-protocol/evidence-semantics.js";
import {
  accumulateEffectiveInteractionEvent,
  createEffectiveInteractionAccumulator,
  effectiveInteractionSuccesses,
} from "../../src/services/run-protocol/effective-interactions.js";
import { validateFinalization } from "../../src/services/run-protocol/finalize-run.js";
import { deriveRunState } from "../../src/services/run-protocol/read-run-state.js";
import { validateRegressionFidelity } from "../../src/services/run-protocol/regression-fidelity.js";
import {
  type RunSnapshot,
  validateRunSnapshot,
} from "../../src/services/run-protocol/run-session.js";
import {
  effectiveVerdictFrom,
  validateVerdictHistory,
} from "../../src/services/run-protocol/verdict-service.js";

const timestamp = "2026-07-13T00:00:00.000Z";
const deadline = "2026-07-13T01:00:00.000Z";
const runId = "run-linear";
const criterionId = "criterion-proof";

interface RegressionFixture {
  workOrder: WorkOrder;
  events: RunEvent[];
  evidence: EvidenceRecord[];
}

function buildRegressionFixture(stepCount: number): RegressionFixture {
  const requiredSteps = Array.from({ length: stepCount }, (_, index) => ({
    id: `step-linear-${String(index)}`,
    order: index,
    intent: `Exercise required step ${String(index)}`,
    tool: "chrome-devtools-mcp" as const,
    target: {
      description: `Required target ${String(index)}`,
      selector: `[data-step="${String(index)}"]`,
      stability: "stable" as const,
      stabilityRationale: "Fixture-owned stable selector",
    },
    expectedState: `Required state ${String(index)} is visible`,
    assertionStrategy: "Observe, capture, and assert the required state",
    evidenceCheckpoints: ["post-action-screenshot", "semantic-ui"],
  }));
  const workOrder = workOrderSchema.parse({
    schemaVersion: 2,
    protocolVersion: "2.0.0",
    runId,
    kind: "regression",
    execution: "local",
    projectId: "project-linear",
    platform: "web",
    startedAt: timestamp,
    goal: "Exercise a linearly scaling regression fixture",
    acceptanceCriteria: [
      {
        id: criterionId,
        description: "Every required state is supported",
        requiredEvidence: ["post-action-screenshot"],
      },
    ],
    requiredSteps,
    readiness: { platform: "web", status: "ready", checks: [] },
    evidencePolicy: {
      screenshots: "required",
      defaultSensitivity: "internal",
    },
    recordingPolicy: { mode: "local-only" },
    budget: {
      maxToolCalls: stepCount * 3,
      maxRecoveryActions: 0,
      deadline,
    },
    pinnedCase: {
      caseId: "linear-case",
      revision: 1,
      caseContentHash: "case-content-hash",
      platformVariantHash: "platform-variant-hash",
    },
  });

  const rawEvents: unknown[] = [];
  const evidence: EvidenceRecord[] = [];
  const assertionIds: string[] = [];
  const evidenceIds: string[] = [];
  const pushEvent = (
    event: Omit<
      RunEvent,
      "schemaVersion" | "runId" | "sequence" | "timestamp" | "platform"
    >,
  ): void => {
    rawEvents.push({
      schemaVersion: 2,
      runId,
      sequence: rawEvents.length + 1,
      timestamp,
      platform: "web",
      ...event,
    });
  };

  pushEvent({
    id: "event-run-started",
    actor: "ai-qa",
    tool: "ai-qa",
    type: "run",
    idempotencyKey: `start-${runId}`,
    payload: {
      phase: "started",
      workOrderHash: `sha256:${"0".repeat(64)}`,
    },
    relatedIds: [],
  });

  for (let index = 0; index < stepCount; index += 1) {
    const suffix = String(index);
    const step = requiredSteps[index]!;
    const interactionId = `event-interaction-${suffix}`;
    const observationActionId = `event-observe-${suffix}`;
    const observationId = `event-observation-${suffix}`;
    const captureActionId = `event-capture-${suffix}`;
    const evidenceId = `evidence-proof-${suffix}`;
    const assertionId = `event-assertion-${suffix}`;

    pushEvent({
      id: interactionId,
      actor: "agent",
      tool: "chrome-devtools-mcp",
      type: "action",
      idempotencyKey: `interaction-${suffix}`,
      payload: {
        phase: "planned",
        kind: "interaction",
        intent: step.intent,
        stepId: step.id,
        target: {
          description: step.target.description,
          selector: step.target.selector,
        },
      },
      relatedIds: [],
    });
    pushEvent({
      id: `event-interaction-complete-${suffix}`,
      actor: "agent",
      tool: "chrome-devtools-mcp",
      type: "action",
      idempotencyKey: `complete:${interactionId}`,
      payload: {
        phase: "completed",
        actionId: interactionId,
        toolResult: { summary: `Required interaction ${suffix} completed` },
      },
      relatedIds: [interactionId],
    });
    pushEvent({
      id: observationActionId,
      actor: "agent",
      tool: "chrome-devtools-mcp",
      type: "action",
      idempotencyKey: `observe-${suffix}`,
      payload: {
        phase: "planned",
        kind: "observation",
        intent: `Observe required step ${suffix}`,
        stepId: step.id,
        target: { description: `Observed target ${suffix}` },
      },
      relatedIds: [],
    });
    pushEvent({
      id: `event-observe-complete-${suffix}`,
      actor: "agent",
      tool: "chrome-devtools-mcp",
      type: "action",
      idempotencyKey: `complete:${observationActionId}`,
      payload: {
        phase: "completed",
        actionId: observationActionId,
        toolResult: { summary: `Observation action ${suffix} completed` },
      },
      relatedIds: [observationActionId],
    });
    pushEvent({
      id: observationId,
      actor: "agent",
      tool: "chrome-devtools-mcp",
      type: "observation",
      idempotencyKey: `observation:${observationActionId}`,
      payload: {
        actionId: observationActionId,
        stepId: step.id,
        summary: `Required state ${suffix} is visible`,
        state: { visible: true, index },
      },
      relatedIds: [observationActionId],
    });
    pushEvent({
      id: captureActionId,
      actor: "agent",
      tool: "chrome-devtools-mcp",
      type: "action",
      idempotencyKey: `capture-${suffix}`,
      payload: {
        phase: "planned",
        kind: "evidence-capture",
        intent: `Capture required step ${suffix}`,
        stepId: step.id,
        target: { description: `Captured target ${suffix}` },
      },
      relatedIds: [],
    });
    pushEvent({
      id: `event-capture-complete-${suffix}`,
      actor: "agent",
      tool: "chrome-devtools-mcp",
      type: "action",
      idempotencyKey: `complete:${captureActionId}`,
      payload: {
        phase: "completed",
        actionId: captureActionId,
        toolResult: { summary: `Evidence capture ${suffix} completed` },
      },
      relatedIds: [captureActionId],
    });
    const evidenceRecord: EvidenceRecord = {
      schemaVersion: 2,
      id: evidenceId,
      runId,
      projectRelativePath: `.ai-qa/evidence/${runId}/files/${evidenceId}-screen.png`,
      contentHash: `sha256:${(index % 10).toString().repeat(64)}`,
      mediaType: "image/png",
      platform: "web",
      sourceTool: "chrome-devtools-mcp",
      capturedAt: timestamp,
      classification: "raw",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId,
      idempotencyKey: `evidence-key-${suffix}`,
    };
    evidence.push(evidenceRecord);
    pushEvent({
      id: `event-evidence-${suffix}`,
      actor: "ai-qa",
      tool: "ai-qa",
      type: "evidence",
      idempotencyKey: evidenceRecord.idempotencyKey,
      payload: {
        ...evidenceRecord,
        criterionIds: [criterionId],
        observationIds: [observationId],
      },
      relatedIds: [captureActionId, observationId],
    });
    const assertionPayload = {
      criterionId,
      status: "satisfied" as const,
      assertionKinds: ["semantic-ui"],
      actual: `Required state ${suffix} is visible`,
      expected: `Required state ${suffix} is visible`,
      observationIds: [observationId],
      evidenceIds: [evidenceId],
      stepId: step.id,
    };
    pushEvent({
      id: assertionId,
      actor: "agent",
      tool: "ai-qa",
      type: "assertion",
      idempotencyKey: `assertion:${sha256Canonical(assertionPayload)}`,
      payload: assertionPayload,
      relatedIds: [observationId, evidenceId],
    });
    assertionIds.push(assertionId);
    evidenceIds.push(evidenceId);
  }

  const decisionPayload = {
    kind: "semantic" as const,
    rationale: "Every required state has typed supporting records",
    relatedIds: [...assertionIds],
  };
  pushEvent({
    id: "event-decision-final",
    actor: "agent",
    tool: "ai-qa",
    type: "decision",
    idempotencyKey: `decision:${sha256Canonical(decisionPayload)}`,
    payload: decisionPayload,
    relatedIds: decisionPayload.relatedIds,
  });
  const blockerPayload = {
    subtype: "environment" as const,
    condition: "A historical non-effective blocker was recorded",
    attemptEventIds: ["event-decision-final"],
    criterionIds: [criterionId],
  };
  pushEvent({
    id: "event-blocker-historical",
    actor: "agent",
    tool: "ai-qa",
    type: "blocker",
    idempotencyKey: `blocker:${sha256Canonical(blockerPayload)}`,
    payload: blockerPayload,
    relatedIds: [
      ...blockerPayload.attemptEventIds,
      ...blockerPayload.criterionIds,
    ],
  });
  const verdictPayload = {
    classification: "pass" as const,
    summary: "Every required step and criterion is satisfied",
    criterionResults: [
      {
        criterionId,
        status: "satisfied" as const,
        assertionIds,
        evidenceIds,
      },
    ],
  };
  pushEvent({
    id: "event-verdict-pass",
    actor: "agent",
    tool: "ai-qa",
    type: "verdict",
    idempotencyKey: `verdict:${sha256Canonical(verdictPayload)}`,
    payload: verdictPayload,
    relatedIds: [...assertionIds, ...evidenceIds],
  });
  pushEvent({
    id: "event-run-completed",
    actor: "ai-qa",
    tool: "ai-qa",
    type: "run",
    idempotencyKey: `finish:${runId}`,
    payload: { phase: "completed", verdictId: "event-verdict-pass" },
    relatedIds: ["event-verdict-pass"],
  });

  return {
    workOrder,
    events: runEventSchema.array().parse(rawEvents),
    evidence,
  };
}

function buildSnapshot(fixture: RegressionFixture): RunSnapshot {
  const lifecycle = validateRunLifecycleHistory(fixture.events, runId);
  const effectiveVerdict = effectiveVerdictFrom(
    validateVerdictHistory(fixture.events, fixture.workOrder),
  );
  if (effectiveVerdict === undefined) {
    throw new Error("fixture requires an effective verdict");
  }
  return {
    workOrder: fixture.workOrder,
    events: fixture.events,
    lifecycle: {
      current: lifecycle.current,
      effectiveVerdict,
    },
  };
}

function indexedAccessesDuring(
  events: RunEvent[],
  validate: (events: RunEvent[]) => void,
): number {
  let accesses = 0;
  const counted = new Proxy(events, {
    get(target, property, receiver) {
      if (
        typeof property === "string" &&
        /^(?:0|[1-9][0-9]*)$/u.test(property)
      ) {
        accesses += 1;
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
  validate(counted);
  return accesses;
}

describe("typed downstream validation", () => {
  it("does not reparse payloads after runEventSchema has typed the journal", () => {
    const fixture = buildRegressionFixture(2);
    const snapshot = buildSnapshot(fixture);
    const effectiveVerdict = snapshot.lifecycle.effectiveVerdict;
    if (effectiveVerdict === undefined) {
      throw new Error("fixture requires an effective verdict");
    }
    const recoveryEvent = runEventSchema.parse({
      schemaVersion: 2,
      id: "event-recovery-standalone",
      runId,
      sequence: 1,
      timestamp,
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      type: "recovery",
      idempotencyKey: "recovery:event-interaction-0",
      payload: {
        actionId: "event-interaction-0",
        resolution: "applied",
        observationId: "event-observation-0",
        rationale: "Typed recovery accumulator coverage",
      },
      relatedIds: ["event-interaction-0", "event-observation-0"],
    });
    const parseSpies = [
      vi.spyOn(actionPayloadSchema, "parse"),
      vi.spyOn(observationPayloadSchema, "parse"),
      vi.spyOn(assertionPayloadSchema, "parse"),
      vi.spyOn(evidenceEventPayloadSchema, "parse"),
      vi.spyOn(decisionPayloadSchema, "parse"),
      vi.spyOn(recoveryPayloadSchema, "parse"),
      vi.spyOn(lifecyclePayloadSchema, "parse"),
      vi.spyOn(blockerPayloadSchema, "parse"),
      vi.spyOn(verdictPayloadSchema, "parse"),
      vi.spyOn(evidenceRecordSchema, "parse"),
      vi.spyOn(actionPayloadSchema, "safeParse"),
      vi.spyOn(observationPayloadSchema, "safeParse"),
      vi.spyOn(assertionPayloadSchema, "safeParse"),
      vi.spyOn(evidenceEventPayloadSchema, "safeParse"),
      vi.spyOn(decisionPayloadSchema, "safeParse"),
      vi.spyOn(recoveryPayloadSchema, "safeParse"),
      vi.spyOn(lifecyclePayloadSchema, "safeParse"),
      vi.spyOn(blockerPayloadSchema, "safeParse"),
      vi.spyOn(verdictPayloadSchema, "safeParse"),
      vi.spyOn(evidenceRecordSchema, "safeParse"),
    ];

    try {
      expect(() => validateRunSnapshot(snapshot)).not.toThrow();
      expect(() => deriveRunState(snapshot)).not.toThrow();
      expect(() =>
        validateRegressionFidelity(fixture.workOrder, fixture.events),
      ).not.toThrow();
      expect(() => effectiveInteractionSuccesses(fixture.events)).not.toThrow();
      expect(() =>
        validateEvidenceParity(fixture.events, fixture.evidence, runId),
      ).not.toThrow();
      expect(() =>
        validatePassEvidenceFreshness(fixture.events, effectiveVerdict.payload),
      ).not.toThrow();
      expect(() =>
        validateFinalization({
          workOrder: fixture.workOrder,
          events: fixture.events,
          evidence: fixture.evidence,
          verdict: effectiveVerdict,
          completionTime: new Date(timestamp),
        }),
      ).not.toThrow();
      const accumulator = createEffectiveInteractionAccumulator();
      accumulateEffectiveInteractionEvent(accumulator, recoveryEvent);

      expect(
        parseSpies.reduce((count, spy) => count + spy.mock.calls.length, 0),
      ).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps required-step checkpoint journal access roughly linear", () => {
    const smaller = buildRegressionFixture(6);
    const larger = buildRegressionFixture(12);
    let smallerResult: ReturnType<typeof validateRegressionFidelity>;
    let largerResult: ReturnType<typeof validateRegressionFidelity>;
    const smallerAccesses = indexedAccessesDuring(smaller.events, (events) => {
      smallerResult = validateRegressionFidelity(smaller.workOrder, events);
    });
    const largerAccesses = indexedAccessesDuring(larger.events, (events) => {
      largerResult = validateRegressionFidelity(larger.workOrder, events);
    });

    expect(smallerResult!.valid).toBe(true);
    expect(largerResult!.valid).toBe(true);
    expect(largerAccesses).toBeLessThanOrEqual(smallerAccesses * 2.4);
  });
});
