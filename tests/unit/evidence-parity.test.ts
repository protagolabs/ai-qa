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

describe("validateEvidenceParity", () => {
  it("rejects an index record without its typed event", () => {
    let thrown: unknown;
    try {
      validateEvidenceParity([], [record], "run-1");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "evidence.integrity_error" });
  });

  it("rejects a typed event without its index record", () => {
    let thrown: unknown;
    try {
      validateEvidenceParity([event], [], "run-1");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "evidence.integrity_error" });
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
