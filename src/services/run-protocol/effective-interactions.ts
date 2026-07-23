import type { RunEvent } from "../../core/runs/schema.js";

type ActionEvent = Extract<RunEvent, { type: "action" }>;
type ObservationEvent = Extract<RunEvent, { type: "observation" }>;
type RecoveryEvent = Extract<RunEvent, { type: "recovery" }>;
type PlannedActionPayload = Extract<
  ActionEvent["payload"],
  { phase: "planned" }
>;

export interface EffectiveInteractionSuccess {
  actionId: string;
  stepId: string;
  planEvent: ActionEvent;
  planPayload: PlannedActionPayload;
  terminalEvent: ActionEvent;
  boundaryEvent: RunEvent;
}

export interface EffectiveInteractionAccumulator {
  plans: Map<string, { event: ActionEvent; payload: PlannedActionPayload }>;
  terminals: Map<string, ActionEvent[]>;
  observations: Map<string, ObservationEvent[]>;
  recoveries: Map<
    string,
    Array<{
      event: RecoveryEvent;
      payload: RecoveryEvent["payload"];
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
    const payload = event.payload;
    if (payload.phase === "planned") {
      state.plans.set(event.id, { event, payload });
    } else {
      const matches = state.terminals.get(payload.actionId) ?? [];
      matches.push(event);
      state.terminals.set(payload.actionId, matches);
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
    const payload = event.payload;
    const matches = state.recoveries.get(payload.actionId) ?? [];
    matches.push({ event, payload });
    state.recoveries.set(payload.actionId, matches);
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
  const terminalPayload = terminalEvent.payload;
  if (terminalPayload.phase === "planned") return undefined;
  if (terminalPayload.phase === "completed") {
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
  const observationPayload = observation.payload;
  const observationPlan = state.plans.get(observationPayload.actionId);
  const observationTerminalMatches =
    state.terminals.get(observationPayload.actionId) ?? [];
  const observationTerminal = observationTerminalMatches[0];
  if (
    observationPayload.stepId !== plan.payload.stepId ||
    observationPlan?.payload.kind !== "observation" ||
    observationPlan.payload.stepId !== plan.payload.stepId ||
    observationTerminalMatches.length !== 1 ||
    observationTerminal === undefined ||
    observationTerminal.payload.phase !== "completed" ||
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
