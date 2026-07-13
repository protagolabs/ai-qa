import { AiQaError } from "../../core/errors.js";
import {
  EvidenceRepository,
  type RegisterRawEvidenceInput,
} from "../../core/evidence/repository.js";
import type { EvidenceRecord } from "../../core/evidence/schema.js";
import { assertJsonValue } from "../../core/json-value.js";
import { actionPayloadSchema } from "../../core/runs/event-payloads.js";
import { RunRepository } from "../../core/runs/repository.js";
import type { RunEvent } from "../../core/runs/schema.js";
import { resolveTrustedProject } from "../project-root/resolve-trusted-project.js";

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
  const runRepository = new RunRepository(trusted.projectRoot, input.now);
  await runRepository.readVerifiedWorkOrder(input.runId);
  const journal = runRepository.journal(input.runId);
  const events = await journal.readAll();
  requireCompletedCaptureAction(events, input.payload.captureActionId);

  const record = await new EvidenceRepository(
    trusted.projectRoot,
    input.runId,
    input.now,
  ).registerRaw(input.payload);
  const eventPayload: unknown = {
    ...record,
    criterionIds: input.criterionIds,
    observationIds: input.observationIds,
  };
  assertJsonValue(eventPayload);
  await journal.append({
    type: "evidence",
    actor: "ai-qa",
    platform: "web",
    tool: "ai-qa",
    idempotencyKey: input.payload.idempotencyKey,
    payload: eventPayload,
    relatedIds: [input.payload.captureActionId, ...input.observationIds],
  });
  return record;
}

function requireCompletedCaptureAction(
  events: RunEvent[],
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
