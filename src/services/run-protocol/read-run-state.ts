import {
  actionPayloadSchema,
  recoveryPayloadSchema,
} from "../../core/runs/event-payloads.js";
import { validateRunLifecycleHistory } from "../../core/runs/lifecycle.js";
import { RunRepository } from "../../core/runs/repository.js";
import { runIdSchema, type RunEvent } from "../../core/runs/schema.js";
import type { VerdictPayload } from "../../core/verdicts/schema.js";
import { resolveTrustedProject } from "../project-root/resolve-trusted-project.js";
import { validateProtocolEvents } from "./run-protocol-service.js";
import {
  effectiveVerdictFrom,
  validateVerdictHistory,
} from "./verdict-service.js";

export interface RunStateSnapshot {
  runId: string;
  status: "running" | "interrupted" | "completed" | "cancelled";
  effectiveVerdict?: VerdictPayload["classification"];
  requiresFreshObservation: boolean;
  permittedNextActions: string[];
}

export async function readRunState(input: {
  projectRoot: string;
  aiQaHome: string;
  runId: string;
  now: () => Date;
}): Promise<RunStateSnapshot> {
  const runId = runIdSchema.parse(input.runId);
  const trusted = await resolveTrustedProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
    aiQaHome: input.aiQaHome,
  });
  const repository = new RunRepository(trusted.projectRoot, input.now);
  return repository.journal(runId).readLocked(async (events) => {
    const workOrder = await repository.readVerifiedWorkOrder(runId);
    validateProtocolEvents(events, workOrder, runId);
    const verdict = effectiveVerdictFrom(
      validateVerdictHistory(events, workOrder),
    );
    const lifecycle = validateRunLifecycleHistory(events, runId);
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
      runId,
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
  });
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
  if (input.hasVerdict) return ["run.finish", "verdict.revise"];

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
      ? ["action.plan", "decision.record"]
      : ["assertion.record", "decision.record"];
  }
  if (latest?.type === "blocker") return ["verdict.set"];
  return ["action.plan", "decision.record"];
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
