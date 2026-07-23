import {
  actionPayloadSchema,
  recoveryPayloadSchema,
} from "../../core/runs/event-payloads.js";
import { runIdSchema, type RunEvent } from "../../core/runs/schema.js";
import type { VerdictPayload } from "../../core/verdicts/schema.js";
import { withRunSession, type RunSnapshot } from "./run-session.js";

export interface RunStateSummary {
  readonly status: "running" | "interrupted" | "completed" | "cancelled";
  readonly effectiveVerdict?: VerdictPayload["classification"];
  readonly requiresFreshObservation: boolean;
}

export interface RunStateSnapshot extends RunStateSummary {
  readonly runId: string;
  readonly permittedNextActions: readonly string[];
}

export async function readRunState(input: {
  projectRoot: string;
  runId: string;
  now: () => Date;
}): Promise<RunStateSnapshot> {
  const runId = runIdSchema.parse(input.runId);
  return withRunSession(input, (session) => ({
    runId,
    ...session.state(),
  }));
}

export function deriveRunState(
  snapshot: RunSnapshot,
): RunStateSummary & { readonly permittedNextActions: readonly string[] } {
  const { events, lifecycle } = snapshot;
  const verdict = lifecycle.effectiveVerdict;
  const requiresFreshObservation = needsFreshObservation(
    events,
    lifecycle.current.event,
    lifecycle.current.payload.phase,
  );
  const status =
    lifecycle.current.payload.phase === "completed" ||
    lifecycle.current.payload.phase === "cancelled" ||
    lifecycle.current.payload.phase === "interrupted"
      ? lifecycle.current.payload.phase
      : "running";
  return {
    status,
    ...(verdict === undefined
      ? {}
      : { effectiveVerdict: verdict.payload.classification }),
    requiresFreshObservation,
    permittedNextActions: permittedNextActions({
      events,
      lifecyclePhase: lifecycle.current.payload.phase,
      requiresFreshObservation,
      hasVerdict: verdict !== undefined,
    }),
  };
}

function needsFreshObservation(
  events: readonly RunEvent[],
  lifecycleEvent: RunEvent,
  phase: string,
): boolean {
  return (
    phase === "resumed" &&
    !events.some(
      (event) =>
        event.type === "observation" &&
        event.sequence > lifecycleEvent.sequence,
    )
  );
}

function permittedNextActions(input: {
  events: readonly RunEvent[];
  lifecyclePhase: string;
  requiresFreshObservation: boolean;
  hasVerdict: boolean;
}): string[] {
  if (
    input.lifecyclePhase === "completed" ||
    input.lifecyclePhase === "cancelled"
  ) {
    return ["report.generate"];
  }
  if (input.lifecyclePhase === "interrupted")
    return ["run.resume", "run.cancel"];
  if (input.requiresFreshObservation) return ["action.plan:observation"];
  if (input.hasVerdict) {
    const requiredProtocolActions = structuralCompletionActions(input.events);
    return requiredProtocolActions.length === 0
      ? ["run.finish", "verdict.revise"]
      : [...requiredProtocolActions, "verdict.revise"];
  }

  const latest = input.events.at(-1);
  if (latest?.type === "action") {
    const payload = actionPayloadSchema.parse(latest.payload);
    if (payload.phase === "planned") return ["invoke-tool", "action.complete"];
    if (payload.phase === "unknown") {
      return ["action.plan:observation", "decision.record"];
    }
    const plan = input.events.find((event) => event.id === payload.actionId);
    const planned = actionPayloadSchema.safeParse(plan?.payload);
    if (planned.success && planned.data.phase === "planned") {
      if (planned.data.kind === "observation") return ["observation.add"];
      if (planned.data.kind === "evidence-capture") return ["evidence.add"];
      return ["action.plan:observation"];
    }
  }
  if (latest?.type === "observation") {
    return hasUnresolvedUnknown(input.events)
      ? ["recovery.resolve", "assertion.record", "action.plan"]
      : ["assertion.record", "action.plan"];
  }
  if (latest?.type === "recovery") {
    const payload = recoveryPayloadSchema.parse(latest.payload);
    return payload.resolution === "not_applied"
      ? ["action.plan", "decision.record", "verdict.set"]
      : ["assertion.record", "decision.record", "verdict.set"];
  }
  if (latest?.type === "blocker") return ["verdict.set"];
  if (latest?.type === "assertion") {
    return ["verdict.set", "action.plan", "decision.record"];
  }
  if (latest?.type === "decision") return ["verdict.set", "action.plan"];
  return ["action.plan", "decision.record"];
}

function structuralCompletionActions(events: readonly RunEvent[]): string[] {
  const plans = events.flatMap((event) => {
    if (event.type !== "action") return [];
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase === "planned" ? [{ event, payload }] : [];
  });
  const terminals = events.flatMap((event) => {
    if (event.type !== "action") return [];
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase === "planned" ? [] : [{ event, payload }];
  });
  if (
    plans.some(
      ({ event }) =>
        !terminals.some(({ payload }) => payload.actionId === event.id),
    )
  ) {
    return ["invoke-tool", "action.complete"];
  }

  const recovered = new Set(
    events.flatMap((event) => {
      if (event.type !== "recovery") return [];
      return [recoveryPayloadSchema.parse(event.payload).actionId];
    }),
  );
  const unresolved = terminals.find(
    ({ payload }) =>
      payload.phase === "unknown" && !recovered.has(payload.actionId),
  );
  if (unresolved === undefined) return [];
  return events.some(
    (event) =>
      event.type === "observation" &&
      event.sequence > unresolved.event.sequence,
  )
    ? ["recovery.resolve"]
    : ["action.plan:observation"];
}

function hasUnresolvedUnknown(events: readonly RunEvent[]): boolean {
  const recovered = new Set(
    events.flatMap((event) => {
      if (event.type !== "recovery") return [];
      return [recoveryPayloadSchema.parse(event.payload).actionId];
    }),
  );
  return events.some((event) => {
    if (event.type !== "action") return false;
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase === "unknown" && !recovered.has(payload.actionId);
  });
}
