import { z } from "zod";
import { canonicalJson } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import { controllerForPlatform } from "../../core/platforms/registry.js";
import { validateEvidenceParity } from "../../core/evidence/parity.js";
import {
  EvidenceRepository,
  registerRawEvidenceInputSchema,
  type RegisterRawEvidenceInput,
} from "../../core/evidence/repository.js";
import {
  evidenceRecordSchema,
  type EvidenceRecord,
} from "../../core/evidence/schema.js";
import {
  actionPayloadSchema,
  evidenceEventPayloadSchema,
  observationPayloadSchema,
  type ActionPayload,
  type EvidenceEventPayload,
} from "../../core/runs/event-payloads.js";
import { validateRunLifecycleHistory } from "../../core/runs/lifecycle.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  criterionIdSchema,
  eventIdSchema,
  type AppendRunEvent,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import { assertJsonValue } from "../../core/json-value.js";
import { resolveProject } from "../project-root/resolve-project.js";
import { validateProtocolEvents } from "./run-protocol-service.js";

const citationInputSchema = z
  .object({
    criterionIds: z.array(criterionIdSchema),
    observationIds: z.array(eventIdSchema),
  })
  .strict();

export async function registerEvidence(input: {
  projectRoot: string;
  runId: string;
  payload: RegisterRawEvidenceInput;
  criterionIds: string[];
  observationIds: string[];
  now: () => Date;
}): Promise<EvidenceRecord> {
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const payload = registerRawEvidenceInputSchema.parse(input.payload);
  const citations = citationInputSchema.parse({
    criterionIds: input.criterionIds,
    observationIds: input.observationIds,
  });
  const runRepository = new RunRepository(project.projectRoot, input.now);
  const journal = runRepository.journal(input.runId);
  const record = await journal.appendPrepared(async (events) => {
    const workOrder = await runRepository.readVerifiedWorkOrder(input.runId);
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
    validateProtocolEvents(events, workOrder, input.runId);
    requireKnownCriteria(workOrder, citations.criterionIds);
    const lifecycle = validateRunLifecycleHistory(events, input.runId);
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
      input.runId,
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

    const record = await repository.registerRaw(payload);
    const eventPayload = evidenceEventPayloadSchema.parse({
      ...record,
      criterionIds: citations.criterionIds,
      observationIds: citations.observationIds,
    });
    return {
      input: evidenceAppendInput(workOrder.platform, eventPayload),
      resolve: () => record,
    };
  });
  await journal.readLocked(async (events) => {
    const workOrder = await runRepository.readVerifiedWorkOrder(input.runId);
    const records = await new EvidenceRepository(
      project.projectRoot,
      input.runId,
      input.now,
      workOrder.platform,
    ).verifyAll();
    validateEvidenceParity(events, records, input.runId);
  });
  return record;
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
    payload: jsonPayload,
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
  for (const observationId of observationIds) {
    const matches = events.filter((event) => event.id === observationId);
    if (
      matches.length !== 1 ||
      matches[0]?.type !== "observation" ||
      !observationPayloadSchema.safeParse(matches[0].payload).success
    ) {
      throw invalidCitation("observation", observationId);
    }
  }
}

function parseExistingEvidenceEvent(
  event: RunEvent,
  idempotencyKey: string,
): EvidenceEventPayload {
  const parsed = evidenceEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) throw idempotencyConflict(idempotencyKey);
  return parsed.data;
}

function evidenceRecordFromEventPayload(
  payload: EvidenceEventPayload,
): EvidenceRecord {
  return evidenceRecordSchema.parse({
    schemaVersion: payload.schemaVersion,
    id: payload.id,
    runId: payload.runId,
    projectRelativePath: payload.projectRelativePath,
    contentHash: payload.contentHash,
    mediaType: payload.mediaType,
    platform: payload.platform,
    sourceTool: payload.sourceTool,
    capturedAt: payload.capturedAt,
    classification: payload.classification,
    sensitivity: payload.sensitivity,
    evidenceKinds: payload.evidenceKinds,
    captureActionId: payload.captureActionId,
    ...(payload.parentEvidenceId === undefined
      ? {}
      : { parentEvidenceId: payload.parentEvidenceId }),
    idempotencyKey: payload.idempotencyKey,
  });
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
  event: RunEvent;
  payload: Extract<ActionPayload, { phase: "planned" }>;
} {
  const actions = events
    .filter((event) => event.type === "action")
    .map((event) => {
      const parsed = actionPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        throw invalidCaptureAction(captureActionId);
      }
      return { event, payload: parsed.data };
    });
  const planned = actions.find(
    ({ event, payload }) =>
      event.id === captureActionId &&
      payload.phase === "planned" &&
      payload.kind === "evidence-capture",
  );
  if (planned === undefined) {
    throw invalidCaptureAction(captureActionId);
  }
  const plannedPayload = planned.payload;
  if (plannedPayload.phase !== "planned") {
    throw invalidCaptureAction(captureActionId);
  }
  const terminals = actions.filter(
    ({ payload }) =>
      payload.phase !== "planned" && payload.actionId === captureActionId,
  );
  if (terminals.length !== 1 || terminals[0]?.payload.phase !== "completed") {
    throw invalidCaptureAction(captureActionId);
  }
  return { event: planned.event, payload: plannedPayload };
}

function invalidCaptureAction(captureActionId: string): AiQaError {
  return new AiQaError(
    "evidence.capture_action_invalid",
    "Evidence requires one completed evidence-capture action",
    { captureActionId },
  );
}
