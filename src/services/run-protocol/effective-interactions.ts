import {
  actionPayloadSchema,
  observationPayloadSchema,
  recoveryPayloadSchema,
} from "../../core/runs/event-payloads.js";
import type { RunEvent } from "../../core/runs/schema.js";

type PlannedActionPayload = Extract<
  ReturnType<typeof actionPayloadSchema.parse>,
  { phase: "planned" }
>;

export interface EffectiveInteractionSuccess {
  actionId: string;
  stepId: string;
  planEvent: RunEvent;
  planPayload: PlannedActionPayload;
  terminalEvent: RunEvent;
  boundaryEvent: RunEvent;
}

export function effectiveInteractionSuccesses(
  events: readonly RunEvent[],
): EffectiveInteractionSuccess[] {
  const plans = new Map<
    string,
    { event: RunEvent; payload: PlannedActionPayload }
  >();
  const terminals = new Map<string, RunEvent[]>();
  const observations = new Map<string, RunEvent[]>();
  const recoveries = new Map<
    string,
    Array<{
      event: RunEvent;
      payload: ReturnType<typeof recoveryPayloadSchema.parse>;
    }>
  >();

  for (const event of events) {
    if (event.type === "action") {
      const payload = actionPayloadSchema.safeParse(event.payload);
      if (!payload.success) continue;
      if (payload.data.phase === "planned") {
        plans.set(event.id, { event, payload: payload.data });
      } else {
        const matches = terminals.get(payload.data.actionId) ?? [];
        matches.push(event);
        terminals.set(payload.data.actionId, matches);
      }
      continue;
    }
    if (event.type === "observation") {
      const matches = observations.get(event.id) ?? [];
      matches.push(event);
      observations.set(event.id, matches);
      continue;
    }
    if (event.type === "recovery") {
      const payload = recoveryPayloadSchema.safeParse(event.payload);
      if (!payload.success) continue;
      const matches = recoveries.get(payload.data.actionId) ?? [];
      matches.push({ event, payload: payload.data });
      recoveries.set(payload.data.actionId, matches);
    }
  }

  return [...plans.entries()].flatMap(([actionId, plan]) => {
    if (plan.payload.kind !== "interaction") return [];
    const terminalMatches = terminals.get(actionId) ?? [];
    const recoveryMatches = recoveries.get(actionId) ?? [];
    if (terminalMatches.length !== 1) return [];
    const terminalEvent = terminalMatches[0]!;
    const terminalPayload = actionPayloadSchema.safeParse(
      terminalEvent.payload,
    );
    if (!terminalPayload.success || terminalPayload.data.phase === "planned") {
      return [];
    }
    if (terminalPayload.data.phase === "completed") {
      return recoveryMatches.length === 0
        ? [
            {
              actionId,
              stepId: plan.payload.stepId,
              planEvent: plan.event,
              planPayload: plan.payload,
              terminalEvent,
              boundaryEvent: terminalEvent,
            },
          ]
        : [];
    }

    if (recoveryMatches.length !== 1) return [];
    const recovery = recoveryMatches[0]!;
    if (
      recovery.payload.resolution !== "applied" ||
      recovery.event.actor !== "ai-qa" ||
      recovery.event.tool !== "ai-qa" ||
      recovery.event.idempotencyKey !== `recovery:${actionId}` ||
      recovery.event.relatedIds.length !== 2 ||
      recovery.event.relatedIds[0] !== actionId ||
      recovery.event.relatedIds[1] !== recovery.payload.observationId
    ) {
      return [];
    }
    const observationMatches =
      observations.get(recovery.payload.observationId) ?? [];
    if (observationMatches.length !== 1) return [];
    const observation = observationMatches[0]!;
    const observationPayload = observationPayloadSchema.safeParse(
      observation.payload,
    );
    if (!observationPayload.success) return [];
    const observationPlan = plans.get(observationPayload.data.actionId);
    const observationTerminalMatches =
      terminals.get(observationPayload.data.actionId) ?? [];
    const observationTerminal = observationTerminalMatches[0];
    const observationTerminalPayload = actionPayloadSchema.safeParse(
      observationTerminal?.payload,
    );
    if (
      observationPayload.data.stepId !== plan.payload.stepId ||
      observationPlan?.payload.kind !== "observation" ||
      observationPlan.payload.stepId !== plan.payload.stepId ||
      observationTerminalMatches.length !== 1 ||
      observationTerminal === undefined ||
      !observationTerminalPayload.success ||
      observationTerminalPayload.data.phase !== "completed" ||
      observationPlan.event.sequence <= terminalEvent.sequence ||
      observationTerminal.sequence <= terminalEvent.sequence ||
      observation.sequence <= terminalEvent.sequence ||
      observationPlan.event.sequence >= observationTerminal.sequence ||
      observationTerminal.sequence >= observation.sequence ||
      recovery.event.sequence <= observation.sequence
    ) {
      return [];
    }
    return [
      {
        actionId,
        stepId: plan.payload.stepId,
        planEvent: plan.event,
        planPayload: plan.payload,
        terminalEvent,
        boundaryEvent: recovery.event,
      },
    ];
  });
}
