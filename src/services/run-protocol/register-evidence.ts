import { z } from "zod";
import { canonicalJson } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import { controllerForPlatform } from "../../core/platforms/registry.js";
import { validateEvidenceParity } from "../../core/evidence/parity.js";
import {
  EvidenceRepository,
  registerRawEvidenceInputSchema,
  type EvidenceRegistrationDurabilityHooks,
  type RegisterRawEvidenceInput,
} from "../../core/evidence/repository.js";
import type { EvidenceRecord } from "../../core/evidence/schema.js";
import {
  evidenceEventPayloadSchema,
  type ActionPayload,
  type EvidenceEventPayload,
} from "../../core/runs/event-payloads.js";
import {
  criterionIdSchema,
  eventIdSchema,
  type AppendRunEvent,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import { assertJsonValue } from "../../core/json-value.js";
import { resolveProject } from "../project-root/resolve-project.js";
import { assertRunSessionActive, withRunSession } from "./run-session.js";

const citationInputSchema = z
  .object({
    criterionIds: z.array(criterionIdSchema),
    observationIds: z.array(eventIdSchema),
  })
  .strict();

export interface RegisterEvidenceOptions {
  hooks?: EvidenceRegistrationDurabilityHooks & {
    beforeJournalAppend?: () => void | Promise<void>;
  };
}

export async function registerEvidence(
  input: {
    projectRoot: string;
    runId: string;
    payload: RegisterRawEvidenceInput;
    criterionIds: string[];
    observationIds: string[];
    now: () => Date;
  },
  options: RegisterEvidenceOptions = {},
): Promise<EvidenceRecord> {
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const payload = registerRawEvidenceInputSchema.parse(input.payload);
  const citations = citationInputSchema.parse({
    criterionIds: input.criterionIds,
    observationIds: input.observationIds,
  });
  return withRunSession(
    {
      projectRoot: project.projectRoot,
      runId: input.runId,
      now: input.now,
      beforeValidate: async ({ events, workOrder }) => {
        const records = await new EvidenceRepository(
          project.projectRoot,
          workOrder.runId,
          input.now,
          workOrder.platform,
        ).readAll();
        validateEvidenceParity(events, records, workOrder.runId);
      },
    },
    async (session) => {
      const { events, lifecycle, workOrder } = session.snapshot;
      const expectedController = controllerForPlatform(workOrder.platform);
      if (payload.sourceTool !== expectedController) {
        throw new AiQaError(
          "evidence.controller_mismatch",
          "Evidence provenance must match the immutable run platform",
          {
            runId: workOrder.runId,
            platform: workOrder.platform,
            expectedController,
            evidencePlatform: workOrder.platform,
            sourceTool: payload.sourceTool,
          },
        );
      }
      requireKnownCriteria(workOrder, citations.criterionIds);
      if (lifecycle.current.payload.phase === "interrupted") {
        throw new AiQaError(
          "run.interrupted",
          "Interrupted runs must be resumed or cancelled before evidence registration",
          { runEventId: lifecycle.current.event.id },
        );
      }
      if (
        lifecycle.current.payload.phase === "completed" ||
        lifecycle.current.payload.phase === "cancelled"
      ) {
        throw new AiQaError(
          "run.terminal",
          "Completed or cancelled runs cannot register evidence",
          { runEventId: lifecycle.current.event.id },
        );
      }
      const existing = events.find(
        (event) => event.idempotencyKey === payload.idempotencyKey,
      );
      if (existing !== undefined && existing.type !== "evidence") {
        throw idempotencyConflict(payload.idempotencyKey);
      }
      const existingPayload =
        existing === undefined
          ? undefined
          : parseExistingEvidenceEvent(existing, payload.idempotencyKey);
      const capture = requireCompletedCaptureAction(
        events,
        payload.captureActionId,
      );
      if (
        capture.event.tool !== expectedController ||
        payload.sourceTool !== capture.event.tool
      ) {
        throw new AiQaError(
          "evidence.controller_mismatch",
          "Evidence provenance must match the immutable run platform",
          {
            runId: workOrder.runId,
            platform: workOrder.platform,
            expectedController,
            evidencePlatform: workOrder.platform,
            sourceTool: payload.sourceTool,
            captureActionId: payload.captureActionId,
            captureActionTool: capture.event.tool,
          },
        );
      }
      requireValidObservations(events, citations.observationIds);

      const repository = new EvidenceRepository(
        project.projectRoot,
        workOrder.runId,
        input.now,
        workOrder.platform,
      );
      if (existingPayload !== undefined) {
        const indexed = (await repository.readAll()).find(
          (record) => record.idempotencyKey === payload.idempotencyKey,
        );
        if (
          indexed === undefined ||
          canonicalJson(indexed) !==
            canonicalJson(evidenceRecordFromEventPayload(existingPayload))
        ) {
          throw new AiQaError(
            "evidence.integrity_error",
            "Evidence event does not match the immutable evidence index",
            { idempotencyKey: payload.idempotencyKey },
          );
        }
      }

      const record = await repository.registerRaw(payload, {
        preCommit: () => assertRunSessionActive(session),
        hooks: {
          ...(options.hooks?.afterEvidenceAncestorsDurable === undefined
            ? {}
            : {
                afterEvidenceAncestorsDurable:
                  options.hooks.afterEvidenceAncestorsDurable,
              }),
          ...(options.hooks?.afterEvidenceFileDurable === undefined
            ? {}
            : {
                afterEvidenceFileDurable:
                  options.hooks.afterEvidenceFileDurable,
              }),
          ...(options.hooks?.afterEvidenceIndexDurable === undefined
            ? {}
            : {
                afterEvidenceIndexDurable:
                  options.hooks.afterEvidenceIndexDurable,
              }),
        },
      });
      const eventPayload = evidenceEventPayloadSchema.parse({
        ...record,
        criterionIds: citations.criterionIds,
        observationIds: citations.observationIds,
      });
      await options.hooks?.beforeJournalAppend?.();
      await session.append([
        evidenceAppendInput(workOrder.platform, eventPayload),
      ]);
      return record;
    },
  );
}

function evidenceAppendInput(
  platform: WorkOrder["platform"],
  payload: EvidenceEventPayload,
): AppendRunEvent {
  const jsonPayload: unknown = payload;
  assertJsonValue(jsonPayload);
  return {
    type: "evidence",
    actor: "ai-qa",
    platform,
    tool: "ai-qa",
    idempotencyKey: payload.idempotencyKey,
    payload,
    relatedIds: [payload.captureActionId, ...payload.observationIds],
  };
}

function requireKnownCriteria(
  workOrder: WorkOrder,
  criterionIds: string[],
): void {
  const known = new Set(
    workOrder.acceptanceCriteria.map((criterion) => criterion.id),
  );
  for (const criterionId of criterionIds) {
    if (!known.has(criterionId)) {
      throw invalidCitation("criterion", criterionId);
    }
  }
}

function requireValidObservations(
  events: readonly RunEvent[],
  observationIds: string[],
): void {
  const eventsById = new Map<string, RunEvent[]>();
  for (const event of events) {
    const matches = eventsById.get(event.id) ?? [];
    matches.push(event);
    eventsById.set(event.id, matches);
  }
  for (const observationId of observationIds) {
    const matches = eventsById.get(observationId) ?? [];
    if (matches.length !== 1 || matches[0]?.type !== "observation") {
      throw invalidCitation("observation", observationId);
    }
  }
}

function parseExistingEvidenceEvent(
  event: Extract<RunEvent, { type: "evidence" }>,
  idempotencyKey: string,
): EvidenceEventPayload {
  if (event.idempotencyKey !== idempotencyKey) {
    throw idempotencyConflict(idempotencyKey);
  }
  return event.payload;
}

function evidenceRecordFromEventPayload(
  payload: EvidenceEventPayload,
): EvidenceRecord {
  const { criterionIds, observationIds, ...record } = payload;
  void criterionIds;
  void observationIds;
  return record;
}

function invalidCitation(kind: "criterion" | "observation", id: string) {
  return new AiQaError(
    "evidence.citation_invalid",
    "Evidence citations must resolve to strict same-run records",
    { kind, id },
  );
}

function idempotencyConflict(idempotencyKey: string): AiQaError {
  return new AiQaError(
    "event.idempotency_conflict",
    "Idempotency key was already used for a different event",
    { idempotencyKey },
  );
}

function requireCompletedCaptureAction(
  events: readonly RunEvent[],
  captureActionId: string,
): {
  event: Extract<RunEvent, { type: "action" }>;
  payload: Extract<ActionPayload, { phase: "planned" }>;
} {
  let planned:
    | {
        event: Extract<RunEvent, { type: "action" }>;
        payload: Extract<ActionPayload, { phase: "planned" }>;
      }
    | undefined;
  const terminals: Array<
    Extract<ActionPayload, { phase: "completed" | "unknown" }>
  > = [];
  for (const event of events) {
    if (event.type !== "action") continue;
    const payload = event.payload;
    if (
      event.id === captureActionId &&
      payload.phase === "planned" &&
      payload.kind === "evidence-capture"
    ) {
      planned = { event, payload };
    } else if (
      payload.phase !== "planned" &&
      payload.actionId === captureActionId
    ) {
      terminals.push(payload);
    }
  }
  if (planned === undefined) {
    throw invalidCaptureAction(captureActionId);
  }
  if (terminals.length !== 1 || terminals[0]?.phase !== "completed") {
    throw invalidCaptureAction(captureActionId);
  }
  return planned;
}

function invalidCaptureAction(captureActionId: string): AiQaError {
  return new AiQaError(
    "evidence.capture_action_invalid",
    "Evidence requires one completed evidence-capture action",
    { captureActionId },
  );
}
