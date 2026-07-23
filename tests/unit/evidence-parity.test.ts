import { describe, expect, it } from "vitest";
import { validateEvidenceParity } from "../../src/core/evidence/parity.js";
import { evidenceRecordSchema } from "../../src/core/evidence/schema.js";
import { runEventSchema } from "../../src/core/runs/schema.js";

const record = evidenceRecordSchema.parse({
  schemaVersion: 2,
  id: "evidence-proof",
  runId: "run-1",
  projectRelativePath: ".ai-qa/evidence/run-1/files/evidence-proof-screen.png",
  contentHash: `sha256:${"0".repeat(64)}`,
  mediaType: "image/png",
  platform: "web",
  sourceTool: "chrome-devtools-mcp",
  capturedAt: "2026-07-13T00:00:00.000Z",
  classification: "raw",
  sensitivity: "internal",
  evidenceKinds: ["post-action-screenshot"],
  captureActionId: "event-capture",
  idempotencyKey: "capture-proof",
});

const event = runEventSchema.parse({
  schemaVersion: 2,
  id: "event-evidence-proof",
  runId: "run-1",
  sequence: 1,
  timestamp: "2026-07-13T00:00:00.000Z",
  actor: "ai-qa",
  platform: "web",
  tool: "ai-qa",
  type: "evidence",
  idempotencyKey: "capture-proof",
  payload: {
    ...record,
    criterionIds: ["criterion-proof"],
    observationIds: ["event-observation"],
  },
  relatedIds: ["event-capture", "event-observation"],
});

const extraRecord = evidenceRecordSchema.parse({
  ...record,
  id: "evidence-extra",
  projectRelativePath: ".ai-qa/evidence/run-1/files/evidence-extra-screen.png",
  captureActionId: "event-capture-extra",
  idempotencyKey: "capture-extra",
});

const extraEvent = runEventSchema.parse({
  ...event,
  id: "event-evidence-extra",
  sequence: 2,
  idempotencyKey: "capture-extra",
  payload: {
    ...extraRecord,
    criterionIds: ["criterion-proof"],
    observationIds: ["event-observation"],
  },
  relatedIds: ["event-capture-extra", "event-observation"],
});

describe("validateEvidenceParity", () => {
  it("classifies an extra trailing index record as an orphan", () => {
    let thrown: unknown;
    try {
      validateEvidenceParity([event], [record, extraRecord], "run-1");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "evidence.orphaned_entries",
      message:
        'Evidence index contains entries with no journal event; run "ai-qa run repair <run-id>"',
      details: {
        runId: "run-1",
        orphanedEvidenceIds: ["evidence-extra"],
      },
    });
  });

  it("rejects a typed event without its index record", () => {
    let thrown: unknown;
    try {
      validateEvidenceParity([event, extraEvent], [record], "run-1");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "evidence.integrity_error" });
  });

  it("rejects different content for a shared ID as an integrity error", () => {
    const mismatched = evidenceRecordSchema.parse({
      ...record,
      contentHash: `sha256:${"1".repeat(64)}`,
    });

    let thrown: unknown;
    try {
      validateEvidenceParity([event], [mismatched], "run-1");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "evidence.integrity_error" });
    expect(thrown).not.toMatchObject({ code: "evidence.orphaned_entries" });
  });

  it("rejects an index-only record owned by another run as integrity", () => {
    const wrongRun = evidenceRecordSchema.parse({
      ...extraRecord,
      runId: "run-2",
      projectRelativePath:
        ".ai-qa/evidence/run-2/files/evidence-extra-screen.png",
    });

    expect(() =>
      validateEvidenceParity([event], [record, wrongRun], "run-1"),
    ).toThrowError(
      expect.objectContaining({ code: "evidence.integrity_error" }),
    );
  });

  it("rejects an index-only controller mismatch as integrity", () => {
    const wrongController = evidenceRecordSchema.parse({
      ...extraRecord,
      sourceTool: "pepper",
    });

    expect(() =>
      validateEvidenceParity([event], [record, wrongController], "run-1"),
    ).toThrowError(
      expect.objectContaining({ code: "evidence.integrity_error" }),
    );
  });

  it("rejects duplicate typed evidence records", () => {
    const duplicate = runEventSchema.parse({
      ...event,
      sequence: 2,
    });

    expect(() =>
      validateEvidenceParity([event, duplicate], [record], "run-1"),
    ).toThrowError(
      expect.objectContaining({ code: "evidence.integrity_error" }),
    );
  });

  it("rejects event-platform and source-controller provenance mismatches", () => {
    const wrongPlatform = runEventSchema.parse({
      ...event,
      platform: "ios-simulator",
    });
    const wrongControllerRecord = evidenceRecordSchema.parse({
      ...record,
      sourceTool: "pepper",
    });
    const wrongController = runEventSchema.parse({
      ...event,
      payload: {
        ...wrongControllerRecord,
        criterionIds: ["criterion-proof"],
        observationIds: ["event-observation"],
      },
    });

    expect(() =>
      validateEvidenceParity([wrongPlatform], [record], "run-1"),
    ).toThrowError(
      expect.objectContaining({ code: "evidence.integrity_error" }),
    );
    expect(() =>
      validateEvidenceParity(
        [wrongController],
        [wrongControllerRecord],
        "run-1",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "evidence.integrity_error" }),
    );
  });
});
