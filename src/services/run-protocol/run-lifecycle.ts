import { sha256Canonical } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import { validateEvidenceParity } from "../../core/evidence/parity.js";
import { EvidenceRepository } from "../../core/evidence/repository.js";
import { createId } from "../../core/ids.js";
import { assertJsonValue } from "../../core/json-value.js";
import type { Platform } from "../../core/platforms/schema.js";
import {
  cancelledRunPayloadSchema,
  interruptedRunPayloadSchema,
  resumedRunPayloadSchema,
  type LifecycleEntry,
  type LifecyclePayload,
} from "../../core/runs/lifecycle.js";
import {
  runIdSchema,
  type AppendRunEvent,
  type RunEvent,
} from "../../core/runs/schema.js";
import {
  verdictPayloadSchema,
  type VerdictPayload,
} from "../../core/verdicts/schema.js";
import {
  sessionCommandState,
  withPreparedRunEventId,
  withRunSession,
  type SessionCommandState,
} from "./run-session.js";

export interface ResumeRunResult extends SessionCommandState {
  readonly runId: string;
  readonly status: "running";
  readonly requiresFreshObservation: true;
}

export async function resumeRun(input: {
  projectRoot: string;
  runId: string;
  now: () => Date;
}): Promise<ResumeRunResult> {
  const runId = runIdSchema.parse(input.runId);
  return withRunSession(
    {
      ...input,
      beforeValidate: async ({ events, workOrder }) => {
        const evidence = await new EvidenceRepository(
          input.projectRoot,
          runId,
          input.now,
          workOrder.platform,
        ).readAll();
        validateEvidenceParity(events, evidence, runId);
      },
    },
    async (session) => {
      const { lifecycle, workOrder } = session.snapshot;
      requireMutableLifecycle(lifecycle.current);
      if (lifecycle.current.payload.phase === "interrupted") {
        await session.append([
          resumedAppend(workOrder.platform, runId, lifecycle.current.event.id),
        ]);
      } else {
        const interruptedEventId = createId("event");
        await session.append([
          withPreparedRunEventId(
            interruptedAppend(
              workOrder.platform,
              runId,
              lifecycle.current.event.id,
            ),
            interruptedEventId,
          ),
          resumedAppend(workOrder.platform, runId, interruptedEventId),
        ]);
      }
      return {
        runId,
        status: "running",
        requiresFreshObservation: true,
        ...sessionCommandState(session),
      };
    },
  );
}

export interface CancelRunResult extends SessionCommandState {
  readonly runId: string;
  readonly status: "cancelled";
  readonly verdict: "not_verified";
}

export async function cancelRun(input: {
  projectRoot: string;
  runId: string;
  reason: string;
  now: () => Date;
}): Promise<CancelRunResult> {
  const runId = runIdSchema.parse(input.runId);
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new AiQaError(
      "run.cancel_reason_required",
      "Cancel reason is required",
    );
  }
  return withRunSession(input, async (session) => {
    const { lifecycle, workOrder } = session.snapshot;
    requireMutableLifecycle(lifecycle.current);
    const current = lifecycle.effectiveVerdict;
    const existingCancellation =
      current?.payload.classification === "not_verified" &&
      current.payload.reasonCode === "cancelled" &&
      current.payload.summary === reason &&
      current.payload.criterionResults.length === 0
        ? current
        : undefined;
    const verdictPayload =
      existingCancellation?.payload ??
      verdictPayloadSchema.parse({
        classification: "not_verified",
        reasonCode: "cancelled",
        summary: reason,
        criterionResults: [],
        ...(current === undefined ? {} : { supersedes: current.event.id }),
      });
    const verdictId = existingCancellation?.event.id ?? createId("event");
    const verdictInput =
      existingCancellation === undefined
        ? withPreparedRunEventId(
            cancellationVerdictAppend(workOrder.platform, verdictPayload),
            verdictId,
          )
        : appendInput(existingCancellation.event);
    const payload = cancelledRunPayloadSchema.parse({
      phase: "cancelled",
      verdictId,
      reason,
    });
    await session.append([
      verdictInput,
      lifecycleAppend(workOrder.platform, `cancel:${runId}`, payload, [
        verdictId,
      ]),
    ]);
    return {
      runId,
      status: "cancelled",
      verdict: "not_verified",
      ...sessionCommandState(session),
    };
  });
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
  payload: LifecyclePayload,
  relatedIds: string[],
): AppendRunEvent {
  const jsonPayload: unknown = payload;
  assertJsonValue(jsonPayload);
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

function cancellationVerdictAppend(
  platform: Platform,
  payload: VerdictPayload,
): AppendRunEvent {
  return {
    type: "verdict",
    actor: "agent",
    platform,
    tool: "ai-qa",
    idempotencyKey: `verdict:${sha256Canonical(payload)}`,
    payload,
    relatedIds: payload.supersedes === undefined ? [] : [payload.supersedes],
  };
}

function appendInput(
  event: Extract<RunEvent, { type: "verdict" }>,
): AppendRunEvent {
  return {
    type: event.type,
    actor: event.actor,
    platform: event.platform,
    tool: event.tool,
    ...(event.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: event.idempotencyKey }),
    payload: event.payload,
    relatedIds: event.relatedIds,
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
