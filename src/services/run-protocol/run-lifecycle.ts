import { AiQaError } from "../../core/errors.js";
import { validateEvidenceParity } from "../../core/evidence/parity.js";
import { EvidenceRepository } from "../../core/evidence/repository.js";
import { assertJsonValue } from "../../core/json-value.js";
import type { Platform } from "../../core/platforms/schema.js";
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
import { resolveProject } from "../project-root/resolve-project.js";
import { validateProtocolEvents } from "./run-protocol-service.js";
import {
  effectiveVerdictFrom,
  validateVerdictHistory,
  VerdictService,
} from "./verdict-service.js";

export async function resumeRun(input: {
  projectRoot: string;
  runId: string;
  now: () => Date;
}): Promise<{
  runId: string;
  status: "running";
  requiresFreshObservation: true;
}> {
  const runId = runIdSchema.parse(input.runId);
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const repository = new RunRepository(project.projectRoot, input.now);
  const journal = repository.journal(runId);

  const first = await journal.appendPrepared(async (events) => {
    const workOrder = await repository.readVerifiedWorkOrder(runId);
    const evidence = await new EvidenceRepository(
      project.projectRoot,
      runId,
      input.now,
      workOrder.platform,
    ).verifyAll();
    validateEvidenceParity(events, evidence, runId);
    validateProtocolEvents(events, workOrder, runId);
    validateVerdictHistory(events, workOrder);
    const lifecycle = validateRunLifecycleHistory(events, runId);
    requireMutableLifecycle(lifecycle.current);
    const append =
      lifecycle.current.payload.phase === "interrupted"
        ? resumedAppend(workOrder.platform, runId, lifecycle.current.event.id)
        : interruptedAppend(
            workOrder.platform,
            runId,
            lifecycle.current.event.id,
          );
    return { input: append, resolve: (event: RunEvent) => event };
  });

  if (isRunPhase(first, "interrupted")) {
    await journal.appendPrepared(async (events) => {
      const workOrder = await repository.readVerifiedWorkOrder(runId);
      const evidence = await new EvidenceRepository(
        project.projectRoot,
        runId,
        input.now,
        workOrder.platform,
      ).verifyAll();
      validateEvidenceParity(events, evidence, runId);
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
        input: resumedAppend(workOrder.platform, runId, first.id),
        resolve: (event: RunEvent) => event,
      };
    });
  }

  return { runId, status: "running", requiresFreshObservation: true };
}

export async function cancelRun(input: {
  projectRoot: string;
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
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const repository = new RunRepository(project.projectRoot, input.now);
  const journal = repository.journal(runId);
  await journal.readLocked(async (events) => {
    const workOrder = await repository.readVerifiedWorkOrder(runId);
    validateProtocolEvents(events, workOrder, runId);
    validateVerdictHistory(events, workOrder);
    requireMutableLifecycle(validateRunLifecycleHistory(events, runId).current);
  });

  const verdictService = new VerdictService(
    project.projectRoot,
    runId,
    input.now,
  );
  const verdict = await verdictService.recordCancellation(reason);

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
      input: lifecycleAppend(workOrder.platform, `cancel:${runId}`, payload, [
        verdict.id,
      ]),
      resolve: (event: RunEvent) => event,
    };
  });

  return { runId, status: "cancelled", verdict: "not_verified" };
}

function interruptedAppend(
  platform: Platform,
  runId: string,
  previousLifecycleEventId: string,
): AppendRunEvent {
  const payload = interruptedRunPayloadSchema.parse({
    phase: "interrupted",
    previousLifecycleEventId,
  });
  return lifecycleAppend(
    platform,
    `interrupt:${runId}:${previousLifecycleEventId}`,
    payload,
    [previousLifecycleEventId],
  );
}

function resumedAppend(
  platform: Platform,
  runId: string,
  interruptedEventId: string,
): AppendRunEvent {
  const payload = resumedRunPayloadSchema.parse({
    phase: "resumed",
    interruptedEventId,
    requiresFreshObservation: true,
  });
  return lifecycleAppend(
    platform,
    `resume:${runId}:${interruptedEventId}`,
    payload,
    [interruptedEventId],
  );
}

function lifecycleAppend(
  platform: Platform,
  idempotencyKey: string,
  payload: unknown,
  relatedIds: string[],
): AppendRunEvent {
  assertJsonValue(payload);
  return {
    type: "run",
    actor: "ai-qa",
    platform,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
