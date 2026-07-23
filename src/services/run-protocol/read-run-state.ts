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
    const payload = latest.payload;
    if (payload.phase === "planned") return ["invoke-tool", "action.complete"];
    if (payload.phase === "unknown") {
      return ["action.plan:observation", "decision.record"];
    }
    const plan = input.events.find((event) => event.id === payload.actionId);
    if (plan?.type === "action" && plan.payload.phase === "planned") {
      if (plan.payload.kind === "observation") return ["observation.add"];
      if (plan.payload.kind === "evidence-capture") return ["evidence.add"];
      return ["action.plan:observation"];
    }
  }
  if (latest?.type === "observation") {
    return hasUnresolvedUnknown(input.events)
      ? ["recovery.resolve", "assertion.record", "action.plan"]
      : ["assertion.record", "action.plan"];
  }
  if (latest?.type === "recovery") {
    const payload = latest.payload;
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
  const planIds = new Set<string>();
  const terminalActionIds = new Set<string>();
  const unknownTerminals: Array<{
    event: Extract<RunEvent, { type: "action" }>;
    actionId: string;
  }> = [];
  const recovered = new Set<string>();
  for (const event of events) {
    if (event.type === "action") {
      const payload = event.payload;
      if (payload.phase === "planned") {
        planIds.add(event.id);
      } else {
        terminalActionIds.add(payload.actionId);
        if (payload.phase === "unknown") {
          unknownTerminals.push({ event, actionId: payload.actionId });
        }
      }
    } else if (event.type === "recovery") {
      recovered.add(event.payload.actionId);
    }
  }
  if ([...planIds].some((actionId) => !terminalActionIds.has(actionId))) {
    return ["invoke-tool", "action.complete"];
  }

  const unresolved = unknownTerminals.find(
    ({ actionId }) => !recovered.has(actionId),
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
  const recovered = new Set<string>();
  const unknownActionIds = new Set<string>();
  for (const event of events) {
    if (event.type === "recovery") {
      recovered.add(event.payload.actionId);
    } else if (event.type === "action" && event.payload.phase === "unknown") {
      unknownActionIds.add(event.payload.actionId);
    }
  }
  return [...unknownActionIds].some((actionId) => !recovered.has(actionId));
}
