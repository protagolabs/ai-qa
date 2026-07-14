import { AiQaError } from "../../core/errors.js";
import {
  actionPayloadSchema,
  assertionPayloadSchema,
  evidenceEventPayloadSchema,
  observationPayloadSchema,
} from "../../core/runs/event-payloads.js";
import type { RunEvent } from "../../core/runs/schema.js";
import type { VerdictPayload } from "../../core/verdicts/schema.js";

export function validatePassEvidenceFreshness(
  events: readonly RunEvent[],
  verdict: VerdictPayload,
): void {
  if (verdict.classification !== "pass") return;

  const byId = new Map(events.map((event) => [event.id, event]));
  const plans = new Map(
    events.flatMap((event) => {
      if (event.type !== "action") return [];
      const payload = actionPayloadSchema.parse(event.payload);
      return payload.phase === "planned"
        ? ([[event.id, { event, payload }]] as const)
        : [];
    }),
  );
  const completedByActionId = new Map(
    events.flatMap((event) => {
      if (event.type !== "action") return [];
      const payload = actionPayloadSchema.parse(event.payload);
      return payload.phase === "completed"
        ? ([[payload.actionId, event]] as const)
        : [];
    }),
  );
  const latestInteractionByStep = new Map<string, RunEvent>();
  for (const [actionId, event] of completedByActionId) {
    const plan = plans.get(actionId);
    if (plan?.payload.kind !== "interaction") continue;
    const latest = latestInteractionByStep.get(plan.payload.stepId);
    if (latest === undefined || event.sequence > latest.sequence) {
      latestInteractionByStep.set(plan.payload.stepId, event);
    }
  }
  const evidenceById = new Map(
    events.flatMap((event) => {
      if (event.type !== "evidence") return [];
      const payload = evidenceEventPayloadSchema.parse(event.payload);
      return [[payload.id, { event, payload }]] as const;
    }),
  );

  for (const result of verdict.criterionResults) {
    const assertions = result.assertionIds.flatMap((assertionId) => {
      const event = byId.get(assertionId);
      return event?.type === "assertion"
        ? [
            {
              event,
              payload: assertionPayloadSchema.parse(event.payload),
            },
          ]
        : [];
    });

    for (const assertion of assertions) {
      if (assertion.payload.status !== "satisfied") continue;
      const stepId = assertion.payload.stepId;
      if (stepId === undefined) {
        throw staleEvidence(assertion.event.id);
      }
      validateObservations({
        eventsById: byId,
        plans,
        completedByActionId,
        observationIds: assertion.payload.observationIds,
        stepId,
        freshnessSequence:
          latestInteractionByStep.get(stepId)?.sequence ?? 0,
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
      const citingAssertions = assertions.filter(({ payload }) =>
        payload.evidenceIds.includes(evidenceId),
      );
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
        ReturnType<typeof actionPayloadSchema.parse>,
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
    const payload = observationPayloadSchema.parse(event.payload);
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
