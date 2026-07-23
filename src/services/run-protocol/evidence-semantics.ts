import { AiQaError } from "../../core/errors.js";
import type { RunEvent } from "../../core/runs/schema.js";
import type { VerdictPayload } from "../../core/verdicts/schema.js";
import { effectiveInteractionSuccesses } from "./effective-interactions.js";

export function validatePassEvidenceFreshness(
  events: readonly RunEvent[],
  verdict: VerdictPayload,
): void {
  if (verdict.classification !== "pass") return;

  const byId = new Map(events.map((event) => [event.id, event]));
  const plans = new Map<
    string,
    {
      event: Extract<RunEvent, { type: "action" }>;
      payload: Extract<
        Extract<RunEvent, { type: "action" }>["payload"],
        { phase: "planned" }
      >;
    }
  >();
  const completedByActionId = new Map<
    string,
    Extract<RunEvent, { type: "action" }>
  >();
  const evidenceById = new Map<
    string,
    {
      event: Extract<RunEvent, { type: "evidence" }>;
      payload: Extract<RunEvent, { type: "evidence" }>["payload"];
    }
  >();
  for (const event of events) {
    if (event.type === "action") {
      const payload = event.payload;
      if (payload.phase === "planned") {
        plans.set(event.id, { event, payload });
      } else if (payload.phase === "completed") {
        completedByActionId.set(payload.actionId, event);
      }
    } else if (event.type === "evidence") {
      evidenceById.set(event.payload.id, {
        event,
        payload: event.payload,
      });
    }
  }
  const interactionSteps = new Set(
    [...plans.values()].flatMap(({ payload }) =>
      payload.kind === "interaction" ? [payload.stepId] : [],
    ),
  );
  const latestInteractionByStep = new Map<string, RunEvent>();
  for (const success of effectiveInteractionSuccesses(events)) {
    const latest = latestInteractionByStep.get(success.stepId);
    if (
      latest === undefined ||
      success.boundaryEvent.sequence > latest.sequence
    ) {
      latestInteractionByStep.set(success.stepId, success.boundaryEvent);
    }
  }
  for (const result of verdict.criterionResults) {
    const assertions = result.assertionIds.flatMap((assertionId) => {
      const event = byId.get(assertionId);
      return event?.type === "assertion"
        ? [{ event, payload: event.payload }]
        : [];
    });
    const assertionsByEvidenceId = new Map<
      string,
      (typeof assertions)[number][]
    >();
    for (const assertion of assertions) {
      for (const evidenceId of assertion.payload.evidenceIds) {
        const citing = assertionsByEvidenceId.get(evidenceId) ?? [];
        citing.push(assertion);
        assertionsByEvidenceId.set(evidenceId, citing);
      }
    }

    for (const assertion of assertions) {
      if (assertion.payload.status !== "satisfied") continue;
      const stepId = assertion.payload.stepId;
      if (stepId === undefined) {
        throw staleEvidence(assertion.event.id);
      }
      if (
        interactionSteps.has(stepId) &&
        !latestInteractionByStep.has(stepId)
      ) {
        throw staleEvidence(assertion.event.id);
      }
      validateObservations({
        eventsById: byId,
        plans,
        completedByActionId,
        observationIds: assertion.payload.observationIds,
        stepId,
        freshnessSequence: latestInteractionByStep.get(stepId)?.sequence ?? 0,
        beforeSequence: assertion.event.sequence,
        assertionId: assertion.event.id,
      });
    }

    for (const evidenceId of result.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (
        evidence === undefined ||
        !evidence.payload.evidenceKinds.includes("post-action-screenshot")
      ) {
        continue;
      }
      const citingAssertions = assertionsByEvidenceId.get(evidenceId) ?? [];
      if (citingAssertions.length === 0) {
        throw staleEvidence(undefined, evidenceId);
      }

      for (const assertion of citingAssertions) {
        const stepId = assertion.payload.stepId;
        const freshnessSequence =
          stepId === undefined
            ? 0
            : (latestInteractionByStep.get(stepId)?.sequence ?? 0);
        const capture = plans.get(evidence.payload.captureActionId);
        const captureCompleted = completedByActionId.get(
          evidence.payload.captureActionId,
        );
        const invalidCapture =
          stepId === undefined ||
          capture?.payload.kind !== "evidence-capture" ||
          capture.payload.stepId !== stepId ||
          capture.event.sequence <= freshnessSequence ||
          captureCompleted === undefined ||
          captureCompleted.sequence <= freshnessSequence ||
          captureCompleted.sequence >= evidence.event.sequence ||
          evidence.event.sequence >= assertion.event.sequence;
        if (invalidCapture) {
          throw staleEvidence(assertion.event.id, evidenceId);
        }

        validateObservations({
          eventsById: byId,
          plans,
          completedByActionId,
          observationIds: evidence.payload.observationIds,
          stepId,
          freshnessSequence,
          beforeSequence: evidence.event.sequence,
          assertionId: assertion.event.id,
          evidenceId,
        });
      }
    }
  }
}

function validateObservations(input: {
  eventsById: ReadonlyMap<string, RunEvent>;
  plans: ReadonlyMap<
    string,
    {
      event: RunEvent;
      payload: Extract<
        Extract<RunEvent, { type: "action" }>["payload"],
        { phase: "planned" }
      >;
    }
  >;
  completedByActionId: ReadonlyMap<string, RunEvent>;
  observationIds: readonly string[];
  stepId: string;
  freshnessSequence: number;
  beforeSequence: number;
  assertionId: string;
  evidenceId?: string;
}): void {
  if (input.observationIds.length === 0) {
    throw staleEvidence(input.assertionId, input.evidenceId);
  }
  for (const observationId of input.observationIds) {
    const event = input.eventsById.get(observationId);
    if (event?.type !== "observation") {
      throw staleEvidence(input.assertionId, input.evidenceId);
    }
    const payload = event.payload;
    const plan = input.plans.get(payload.actionId);
    const completed = input.completedByActionId.get(payload.actionId);
    if (
      payload.stepId !== input.stepId ||
      plan?.payload.kind !== "observation" ||
      plan.payload.stepId !== input.stepId ||
      plan.event.sequence <= input.freshnessSequence ||
      completed === undefined ||
      completed.sequence <= input.freshnessSequence ||
      completed.sequence >= event.sequence ||
      event.sequence <= input.freshnessSequence ||
      event.sequence >= input.beforeSequence
    ) {
      throw staleEvidence(input.assertionId, input.evidenceId);
    }
  }
}

function staleEvidence(
  assertionId: string | undefined,
  evidenceId?: string,
): AiQaError {
  return new AiQaError(
    "verdict.stale_post_action_evidence",
    "Post-action evidence must be captured from fresh observations for the asserted step",
    {
      ...(assertionId === undefined ? {} : { assertionId }),
      ...(evidenceId === undefined ? {} : { evidenceId }),
    },
  );
}
