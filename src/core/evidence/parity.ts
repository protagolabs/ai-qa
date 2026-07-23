import { canonicalJson } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { controllerForPlatform } from "../platforms/registry.js";
import { evidenceEventPayloadSchema } from "../runs/event-payloads.js";
import type { RunEvent } from "../runs/schema.js";
import { evidenceRecordSchema, type EvidenceRecord } from "./schema.js";

export function validateEvidenceParity(
  events: readonly RunEvent[],
  records: readonly EvidenceRecord[],
  runId: string,
): void {
  let indexed: Map<string, EvidenceRecord>;
  let eventRecords: Map<string, EvidenceRecord>;
  try {
    indexed = new Map(records.map((record) => [record.id, record]));
    if (indexed.size !== records.length)
      throw new Error("duplicate index record");

    eventRecords = new Map<string, EvidenceRecord>();
    for (const event of events) {
      if (event.type !== "evidence") continue;
      const payload = evidenceEventPayloadSchema.parse(event.payload);
      const { criterionIds, observationIds, ...recordInput } = payload;
      void criterionIds;
      void observationIds;
      const record = evidenceRecordSchema.parse(recordInput);
      if (
        event.platform !== record.platform ||
        record.sourceTool !== controllerForPlatform(record.platform)
      ) {
        throw new Error("evidence provenance mismatch");
      }
      if (eventRecords.has(record.id))
        throw new Error("duplicate event record");
      eventRecords.set(record.id, record);
    }
  } catch {
    throw evidenceIntegrityError(runId);
  }

  const orphanedEvidenceIds = [...indexed.keys()].filter(
    (id) => !eventRecords.has(id),
  );
  if (orphanedEvidenceIds.length > 0) {
    throw new AiQaError(
      "evidence.orphaned_entries",
      'Evidence index contains entries with no journal event; run "ai-qa run repair <run-id>"',
      { runId, orphanedEvidenceIds },
    );
  }

  const missingIndexIds = [...eventRecords.keys()].filter(
    (id) => !indexed.has(id),
  );
  if (missingIndexIds.length > 0) {
    throw evidenceIntegrityError(runId);
  }

  try {
    for (const [id, record] of indexed) {
      const fromEvent = eventRecords.get(id);
      if (
        record.runId !== runId ||
        fromEvent === undefined ||
        canonicalJson(record) !== canonicalJson(fromEvent)
      ) {
        throw new Error("record mismatch");
      }
    }
  } catch {
    throw evidenceIntegrityError(runId);
  }
}

function evidenceIntegrityError(runId: string): AiQaError {
  return new AiQaError(
    "evidence.integrity_error",
    "Evidence index does not exactly match typed run evidence events",
    { runId },
  );
}
