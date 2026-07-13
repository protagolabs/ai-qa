import { z } from "zod";
import { canonicalJson } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
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
  type EvidenceEventPayload,
} from "../../core/runs/event-payloads.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  criterionIdSchema,
  eventIdSchema,
  type AppendRunEvent,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import { assertJsonValue } from "../../core/json-value.js";
import { resolveTrustedProject } from "../project-root/resolve-trusted-project.js";

const citationInputSchema = z
  .object({
    criterionIds: z.array(criterionIdSchema),
    observationIds: z.array(eventIdSchema),
  })
  .strict();

export async function registerEvidence(input: {
  projectRoot: string;
  aiQaHome: string;
  runId: string;
  payload: RegisterRawEvidenceInput;
  criterionIds: string[];
  observationIds: string[];
  now: () => Date;
}): Promise<EvidenceRecord> {
  const trusted = await resolveTrustedProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
    aiQaHome: input.aiQaHome,
  });
  const payload = registerRawEvidenceInputSchema.parse(input.payload);
  const citations = citationInputSchema.parse({
    criterionIds: input.criterionIds,
    observationIds: input.observationIds,
  });
  const runRepository = new RunRepository(trusted.projectRoot, input.now);
  const workOrder = await runRepository.readVerifiedWorkOrder(input.runId);
  requireKnownCriteria(workOrder, citations.criterionIds);
  const journal = runRepository.journal(input.runId);
  return journal.appendPrepared(async (events) => {
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
    requireCompletedCaptureAction(events, payload.captureActionId);
    requireValidObservations(events, citations.observationIds);

    const repository = new EvidenceRepository(
      trusted.projectRoot,
      input.runId,
      input.now,
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
      input: evidenceAppendInput(eventPayload),
      resolve: () => record,
    };
  });
}

function evidenceAppendInput(payload: EvidenceEventPayload): AppendRunEvent {
  const jsonPayload: unknown = payload;
  assertJsonValue(jsonPayload);
  return {
    type: "evidence",
    actor: "ai-qa",
    platform: "web",
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
): void {
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
      event.id === captureActionId && payload.phase === "planned",
  );
  if (
    planned === undefined ||
    planned.payload.phase !== "planned" ||
    planned.payload.kind !== "evidence-capture"
  ) {
    throw invalidCaptureAction(captureActionId);
  }
  const terminals = actions.filter(
    ({ payload }) =>
      payload.phase !== "planned" && payload.actionId === captureActionId,
  );
  if (terminals.length !== 1 || terminals[0]?.payload.phase !== "completed") {
    throw invalidCaptureAction(captureActionId);
  }
}

function invalidCaptureAction(captureActionId: string): AiQaError {
  return new AiQaError(
    "evidence.capture_action_invalid",
    "Evidence requires one completed evidence-capture action",
    { captureActionId },
  );
}
