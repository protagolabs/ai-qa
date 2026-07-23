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

export interface EffectiveInteractionAccumulator {
  plans: Map<string, { event: RunEvent; payload: PlannedActionPayload }>;
  terminals: Map<string, RunEvent[]>;
  observations: Map<string, RunEvent[]>;
  recoveries: Map<
    string,
    Array<{
      event: RunEvent;
      payload: ReturnType<typeof recoveryPayloadSchema.parse>;
    }>
  >;
}

export function createEffectiveInteractionAccumulator(): EffectiveInteractionAccumulator {
  return {
    plans: new Map(),
    terminals: new Map(),
    observations: new Map(),
    recoveries: new Map(),
  };
}

export function accumulateEffectiveInteractionEvent(
  state: EffectiveInteractionAccumulator,
  event: RunEvent,
): void {
  if (event.type === "action") {
    const payload = actionPayloadSchema.safeParse(event.payload);
    if (!payload.success) return;
    if (payload.data.phase === "planned") {
      state.plans.set(event.id, { event, payload: payload.data });
    } else {
      const matches = state.terminals.get(payload.data.actionId) ?? [];
      matches.push(event);
      state.terminals.set(payload.data.actionId, matches);
    }
    return;
  }
  if (event.type === "observation") {
    const matches = state.observations.get(event.id) ?? [];
    matches.push(event);
    state.observations.set(event.id, matches);
    return;
  }
  if (event.type === "recovery") {
    const payload = recoveryPayloadSchema.safeParse(event.payload);
    if (!payload.success) return;
    const matches = state.recoveries.get(payload.data.actionId) ?? [];
    matches.push({ event, payload: payload.data });
    state.recoveries.set(payload.data.actionId, matches);
  }
}

export function effectiveInteractionSuccessFor(
  state: EffectiveInteractionAccumulator,
  actionId: string,
): EffectiveInteractionSuccess | undefined {
  const plan = state.plans.get(actionId);
  if (plan?.payload.kind !== "interaction") return undefined;
  const terminalMatches = state.terminals.get(actionId) ?? [];
  const recoveryMatches = state.recoveries.get(actionId) ?? [];
  if (terminalMatches.length !== 1) return undefined;
  const terminalEvent = terminalMatches[0]!;
  const terminalPayload = actionPayloadSchema.safeParse(terminalEvent.payload);
  if (!terminalPayload.success || terminalPayload.data.phase === "planned") {
    return undefined;
  }
  if (terminalPayload.data.phase === "completed") {
    return recoveryMatches.length === 0
      ? {
          actionId,
          stepId: plan.payload.stepId,
          planEvent: plan.event,
          planPayload: plan.payload,
          terminalEvent,
          boundaryEvent: terminalEvent,
        }
      : undefined;
  }

  if (recoveryMatches.length !== 1) return undefined;
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
    return undefined;
  }
  const observationMatches =
    state.observations.get(recovery.payload.observationId) ?? [];
  if (observationMatches.length !== 1) return undefined;
  const observation = observationMatches[0]!;
  const observationPayload = observationPayloadSchema.safeParse(
    observation.payload,
  );
  if (!observationPayload.success) return undefined;
  const observationPlan = state.plans.get(observationPayload.data.actionId);
  const observationTerminalMatches =
    state.terminals.get(observationPayload.data.actionId) ?? [];
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
    return undefined;
  }
  return {
    actionId,
    stepId: plan.payload.stepId,
    planEvent: plan.event,
    planPayload: plan.payload,
    terminalEvent,
    boundaryEvent: recovery.event,
  };
}

export function effectiveInteractionSuccesses(
  events: readonly RunEvent[],
): EffectiveInteractionSuccess[] {
  const state = createEffectiveInteractionAccumulator();
  for (const event of events) {
    accumulateEffectiveInteractionEvent(state, event);
  }
  return [...state.plans.keys()].flatMap((actionId) => {
    const success = effectiveInteractionSuccessFor(state, actionId);
    return success === undefined ? [] : [success];
  });
}
