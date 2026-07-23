import { z } from "zod";
import { canonicalJson } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { eventIdSchema } from "./ids.js";

export const interruptedRunPayloadSchema = z
  .object({
    phase: z.literal("interrupted"),
    previousLifecycleEventId: eventIdSchema,
  })
  .strict();

export const resumedRunPayloadSchema = z
  .object({
    phase: z.literal("resumed"),
    interruptedEventId: eventIdSchema,
    requiresFreshObservation: z.literal(true),
  })
  .strict();

export const completedRunPayloadSchema = z
  .object({
    phase: z.literal("completed"),
    verdictId: eventIdSchema,
  })
  .strict();

export const cancelledRunPayloadSchema = z
  .object({
    phase: z.literal("cancelled"),
    verdictId: eventIdSchema,
    reason: z.string().trim().min(1),
  })
  .strict();

const startedRunPayloadSchema = z
  .object({
    phase: z.literal("started"),
    workOrderHash: z.string().trim().min(1),
  })
  .strict();

export const lifecyclePayloadSchema = z.union([
  startedRunPayloadSchema,
  interruptedRunPayloadSchema,
  resumedRunPayloadSchema,
  completedRunPayloadSchema,
  cancelledRunPayloadSchema,
]);

export type LifecyclePayload = z.infer<typeof lifecyclePayloadSchema>;

export interface LifecycleHistoryEvent {
  type: string;
  id: string;
  timestamp: string;
  actor: string;
  tool: string;
  idempotencyKey?: string | undefined;
  relatedIds: string[];
  payload: unknown;
}

export interface LifecycleEntry<
  Event extends LifecycleHistoryEvent = LifecycleHistoryEvent,
> {
  event: Event;
  payload: LifecyclePayload;
}

export function validateRunLifecycleHistory<
  Event extends LifecycleHistoryEvent,
>(
  events: readonly Event[],
  runId: string,
): { current: LifecycleEntry<Extract<Event, { type: "run" }>> } {
  try {
    let current: LifecycleEntry<Extract<Event, { type: "run" }>> | undefined;
    for (const event of events) {
      if (event.type !== "run") continue;
      const lifecycleEvent = event as Extract<Event, { type: "run" }>;
      const payload = lifecyclePayloadSchema.parse(lifecycleEvent.payload);
      switch (payload.phase) {
        case "started":
          requireLifecycle(current === undefined);
          requireMetadata(lifecycleEvent, `start-${runId}`, []);
          break;
        case "interrupted":
          requireLifecycle(
            current?.payload.phase === "started" ||
              current?.payload.phase === "resumed",
          );
          requireLifecycle(
            payload.previousLifecycleEventId === current.event.id,
          );
          requireMetadata(
            lifecycleEvent,
            `interrupt:${runId}:${current.event.id}`,
            [current.event.id],
          );
          break;
        case "resumed":
          requireLifecycle(current?.payload.phase === "interrupted");
          requireLifecycle(payload.interruptedEventId === current.event.id);
          requireMetadata(
            lifecycleEvent,
            `resume:${runId}:${current.event.id}`,
            [current.event.id],
          );
          break;
        case "completed":
          requireLifecycle(
            current?.payload.phase === "started" ||
              current?.payload.phase === "resumed",
          );
          requireMetadata(lifecycleEvent, `finish:${runId}`, [
            payload.verdictId,
          ]);
          break;
        case "cancelled":
          requireLifecycle(
            current !== undefined &&
              current.payload.phase !== "completed" &&
              current.payload.phase !== "cancelled",
          );
          requireMetadata(lifecycleEvent, `cancel:${runId}`, [
            payload.verdictId,
          ]);
          break;
      }
      current = { event: lifecycleEvent, payload };
    }
    requireLifecycle(current !== undefined);
    return { current };
  } catch {
    throw new AiQaError(
      "run_protocol.integrity_error",
      "Run lifecycle history validation failed",
      { runId },
    );
  }
}

function requireMetadata(
  event: LifecycleHistoryEvent,
  idempotencyKey: string,
  relatedIds: string[],
): void {
  requireLifecycle(event.actor === "ai-qa");
  requireLifecycle(event.tool === "ai-qa");
  requireLifecycle(event.idempotencyKey === idempotencyKey);
  requireLifecycle(
    canonicalJson(event.relatedIds) === canonicalJson(relatedIds),
  );
}

function requireLifecycle(condition: boolean): asserts condition {
  if (!condition) throw new Error("lifecycle invariant failed");
}
