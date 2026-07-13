import { AiQaError } from "../../core/errors.js";
import { EvidenceRepository } from "../../core/evidence/repository.js";
import { assertJsonValue } from "../../core/json-value.js";
import {
  cancelledRunPayloadSchema,
  interruptedRunPayloadSchema,
  resumedRunPayloadSchema,
  validateRunLifecycleHistory,
  type LifecycleEntry,
} from "../../core/runs/lifecycle.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  runIdSchema,
  type AppendRunEvent,
  type RunEvent,
} from "../../core/runs/schema.js";
import type { VerdictPayload } from "../../core/verdicts/schema.js";
import { resolveTrustedProject } from "../project-root/resolve-trusted-project.js";
import { validateProtocolEvents } from "./run-protocol-service.js";
import {
  effectiveVerdictFrom,
  validateVerdictHistory,
  VerdictService,
} from "./verdict-service.js";

export async function resumeRun(input: {
  projectRoot: string;
  aiQaHome: string;
  runId: string;
  now: () => Date;
}): Promise<{
  runId: string;
  status: "running";
  requiresFreshObservation: true;
}> {
  const runId = runIdSchema.parse(input.runId);
  const trusted = await resolveTrustedProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
    aiQaHome: input.aiQaHome,
  });
  const repository = new RunRepository(trusted.projectRoot, input.now);
  const journal = repository.journal(runId);

  const first = await journal.appendPrepared(async (events) => {
    const workOrder = await repository.readVerifiedWorkOrder(runId);
    validateProtocolEvents(events, workOrder, runId);
    validateVerdictHistory(events, workOrder);
    const lifecycle = validateRunLifecycleHistory(events, runId);
    requireMutableLifecycle(lifecycle.current);
    await new EvidenceRepository(
      trusted.projectRoot,
      runId,
      input.now,
    ).verifyAll();
    const append =
      lifecycle.current.payload.phase === "interrupted"
        ? resumedAppend(runId, lifecycle.current.event.id)
        : interruptedAppend(runId, lifecycle.current.event.id);
    return { input: append, resolve: (event: RunEvent) => event };
  });

  if (isRunPhase(first, "interrupted")) {
    await journal.appendPrepared(async (events) => {
      const workOrder = await repository.readVerifiedWorkOrder(runId);
      validateProtocolEvents(events, workOrder, runId);
      validateVerdictHistory(events, workOrder);
      const lifecycle = validateRunLifecycleHistory(events, runId);
      requireMutableLifecycle(lifecycle.current);
      if (lifecycle.current.event.id !== first.id) {
        throw new AiQaError(
          "run.resume_conflict",
          "Run lifecycle changed while resuming",
          { runId },
        );
      }
      return {
        input: resumedAppend(runId, first.id),
        resolve: (event: RunEvent) => event,
      };
    });
  }

  return { runId, status: "running", requiresFreshObservation: true };
}

export async function cancelRun(input: {
  projectRoot: string;
  aiQaHome: string;
  runId: string;
  reason: string;
  now: () => Date;
}): Promise<{
  runId: string;
  status: "cancelled";
  verdict: "not_verified";
}> {
  const runId = runIdSchema.parse(input.runId);
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new AiQaError(
      "run.cancel_reason_required",
      "Cancel reason is required",
    );
  }
  const trusted = await resolveTrustedProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
    aiQaHome: input.aiQaHome,
  });
  const repository = new RunRepository(trusted.projectRoot, input.now);
  const journal = repository.journal(runId);
  await journal.readLocked(async (events) => {
    const workOrder = await repository.readVerifiedWorkOrder(runId);
    validateProtocolEvents(events, workOrder, runId);
    validateVerdictHistory(events, workOrder);
    requireMutableLifecycle(validateRunLifecycleHistory(events, runId).current);
  });

  const verdictService = new VerdictService(
    trusted.projectRoot,
    input.aiQaHome,
    runId,
    input.now,
  );
  const current = await verdictService.effectiveVerdict();
  let verdict: RunEvent;
  if (current !== undefined && isCancelledVerdict(current, reason)) {
    verdict = current;
  } else {
    const payload: VerdictPayload = {
      classification: "not_verified",
      reasonCode: "cancelled",
      summary: reason,
      criterionResults: [],
      ...(current === undefined ? {} : { supersedes: current.id }),
    };
    verdict =
      current === undefined
        ? await verdictService.set(payload)
        : await verdictService.revise({ ...payload, supersedes: current.id });
  }

  await journal.appendPrepared(async (events) => {
    const workOrder = await repository.readVerifiedWorkOrder(runId);
    validateProtocolEvents(events, workOrder, runId);
    const effective = effectiveVerdictFrom(
      validateVerdictHistory(events, workOrder),
    );
    const lifecycle = validateRunLifecycleHistory(events, runId);
    requireMutableLifecycle(lifecycle.current);
    if (effective?.event.id !== verdict.id) {
      throw new AiQaError(
        "run.cancel_verdict_conflict",
        "Cancel verdict is no longer effective",
        { runId },
      );
    }
    const payload = cancelledRunPayloadSchema.parse({
      phase: "cancelled",
      verdictId: verdict.id,
      reason,
    });
    return {
      input: lifecycleAppend(`cancel:${runId}`, payload, [verdict.id]),
      resolve: (event: RunEvent) => event,
    };
  });

  return { runId, status: "cancelled", verdict: "not_verified" };
}

function interruptedAppend(
  runId: string,
  previousLifecycleEventId: string,
): AppendRunEvent {
  const payload = interruptedRunPayloadSchema.parse({
    phase: "interrupted",
    previousLifecycleEventId,
  });
  return lifecycleAppend(
    `interrupt:${runId}:${previousLifecycleEventId}`,
    payload,
    [previousLifecycleEventId],
  );
}

function resumedAppend(
  runId: string,
  interruptedEventId: string,
): AppendRunEvent {
  const payload = resumedRunPayloadSchema.parse({
    phase: "resumed",
    interruptedEventId,
    requiresFreshObservation: true,
  });
  return lifecycleAppend(`resume:${runId}:${interruptedEventId}`, payload, [
    interruptedEventId,
  ]);
}

function lifecycleAppend(
  idempotencyKey: string,
  payload: unknown,
  relatedIds: string[],
): AppendRunEvent {
  assertJsonValue(payload);
  return {
    type: "run",
    actor: "ai-qa",
    platform: "web",
    tool: "ai-qa",
    idempotencyKey,
    payload,
    relatedIds,
  };
}

function requireMutableLifecycle(entry: LifecycleEntry): void {
  if (
    entry.payload.phase === "completed" ||
    entry.payload.phase === "cancelled"
  ) {
    throw new AiQaError(
      "run.terminal",
      "Completed or cancelled runs cannot change lifecycle state",
      { runEventId: entry.event.id },
    );
  }
}

function isRunPhase(event: RunEvent, phase: string): boolean {
  return isRecord(event.payload) && event.payload.phase === phase;
}

function isCancelledVerdict(event: RunEvent, reason: string): boolean {
  return (
    isRecord(event.payload) &&
    event.payload.classification === "not_verified" &&
    event.payload.reasonCode === "cancelled" &&
    event.payload.summary === reason
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
