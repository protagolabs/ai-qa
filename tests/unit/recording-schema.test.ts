import { describe, expect, it } from "vitest";
import {
  recordingArtifactSchema,
  recordingEventIdSchema,
  recordingEventSchema,
  recordingIdempotencyKeySchema,
  recordingReceiptInputSchema,
  recordingReferenceSchema,
  reportSubjectSchema,
} from "../../src/core/recording/schema.js";

const validEvent = {
  schemaVersion: 2,
  eventId: "recording-00000000-0000-0000-0000-000000000001",
  subject: { kind: "run", id: "run-1" },
  recordedAt: "2026-07-15T01:00:00.000Z",
  idempotencyKey: "receipt-1",
  status: "recorded",
  references: ["opaque-reference"],
} as const;

describe("recording repository schemas", () => {
  it("accepts only strict run and run-group recording subjects", () => {
    expect(reportSubjectSchema.parse({ kind: "run", id: "run-1" })).toEqual({
      kind: "run",
      id: "run-1",
    });
    expect(
      reportSubjectSchema.parse({
        kind: "run-group",
        id: "run-group-release-matrix",
      }),
    ).toEqual({ kind: "run-group", id: "run-group-release-matrix" });
    expect(
      reportSubjectSchema.safeParse({ kind: "run", id: "run-group-wrong" })
        .success,
    ).toBe(false);
    expect(
      reportSubjectSchema.safeParse({
        kind: "run-group",
        id: "run-1",
      }).success,
    ).toBe(false);
    expect(
      reportSubjectSchema.safeParse({
        kind: "run",
        id: "run-1",
        runId: "run-1",
      }).success,
    ).toBe(false);
  });

  it("enforces the exact idempotency-key alphabet and length boundaries", () => {
    expect(recordingIdempotencyKeySchema.safeParse("").success).toBe(false);
    expect(recordingIdempotencyKeySchema.safeParse("a").success).toBe(true);
    expect(
      recordingIdempotencyKeySchema.safeParse("a".repeat(128)).success,
    ).toBe(true);
    expect(
      recordingIdempotencyKeySchema.safeParse("a".repeat(129)).success,
    ).toBe(false);
    expect(recordingIdempotencyKeySchema.safeParse("AZaz09._:-").success).toBe(
      true,
    );
    for (const invalid of ["white space", "slash/key", "unicode-😀"]) {
      expect(recordingIdempotencyKeySchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("enforces the recording event UUID-shaped identifier", () => {
    expect(recordingEventIdSchema.safeParse(validEvent.eventId).success).toBe(
      true,
    );
    for (const invalid of [
      "event-00000000-0000-0000-0000-000000000001",
      "recording-00000000-0000-0000-0000-00000000001",
      "recording-00000000-0000-0000-0000-00000000000G",
    ]) {
      expect(recordingEventIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects an empty reference and accepts one Unicode code point", () => {
    expect(recordingReferenceSchema.safeParse("").success).toBe(false);
    expect(recordingReferenceSchema.safeParse("a").success).toBe(true);
    expect(recordingReferenceSchema.safeParse("😀").success).toBe(true);
  });

  it("counts astral references by Unicode code point at 2,048 and 2,049", () => {
    expect(recordingReferenceSchema.safeParse("😀".repeat(2048)).success).toBe(
      true,
    );
    expect(recordingReferenceSchema.safeParse("😀".repeat(2049)).success).toBe(
      false,
    );
    expect(recordingReferenceSchema.safeParse("a".repeat(2048)).success).toBe(
      true,
    );
    expect(recordingReferenceSchema.safeParse("a".repeat(2049)).success).toBe(
      false,
    );
  });

  it("rejects C0, DEL, C1, CR, and LF control characters", () => {
    for (const control of [
      "\u0000",
      "\u001f",
      "\u007f",
      "\u0080",
      "\u009f",
      "\r",
      "\n",
    ]) {
      expect(
        recordingReferenceSchema.safeParse(`before${control}after`).success,
      ).toBe(false);
    }
  });

  it("accepts 20 references and rejects 21", () => {
    const receipt = {
      status: "recorded",
      references: Array.from({ length: 20 }, (_, index) => `ref-${index}`),
    };
    expect(recordingReceiptInputSchema.safeParse(receipt).success).toBe(true);
    expect(
      recordingReceiptInputSchema.safeParse({
        ...receipt,
        references: [...receipt.references, "ref-20"],
      }).success,
    ).toBe(false);
  });

  it("requires recorded references and forbids not-recorded references", () => {
    expect(
      recordingReceiptInputSchema.safeParse({
        status: "recorded",
        references: [],
      }).success,
    ).toBe(false);
    expect(
      recordingReceiptInputSchema.safeParse({
        status: "recorded",
        references: ["ref"],
      }).success,
    ).toBe(true);
    expect(
      recordingReceiptInputSchema.safeParse({
        status: "not_recorded",
        references: [],
      }).success,
    ).toBe(true);
    expect(
      recordingReceiptInputSchema.safeParse({
        status: "not_recorded",
        references: ["ref"],
      }).success,
    ).toBe(false);
  });

  it("accepts only empty references for unknown receipts", () => {
    expect(
      recordingReceiptInputSchema.safeParse({
        status: "unknown",
        references: [],
      }).success,
    ).toBe(true);
    expect(
      recordingReceiptInputSchema.safeParse({
        status: "unknown",
        references: ["must-be-empty"],
      }).success,
    ).toBe(false);
  });

  it("accepts only status and references in public receipt input", () => {
    expect(
      recordingReceiptInputSchema.parse({
        status: "recorded",
        references: ["docs/qa-results.md#run-sample"],
      }),
    ).toEqual({
      status: "recorded",
      references: ["docs/qa-results.md#run-sample"],
    });
    expect(() =>
      recordingReceiptInputSchema.parse({
        idempotencyKey: "caller-owned",
        status: "recorded",
        references: ["docs/qa-results.md#run-sample"],
      }),
    ).toThrow();
  });

  it("applies status/reference rules to persisted events", () => {
    expect(recordingEventSchema.safeParse(validEvent).success).toBe(true);
    expect(
      recordingEventSchema.safeParse({
        ...validEvent,
        status: "recorded",
        references: [],
      }).success,
    ).toBe(false);
    expect(
      recordingEventSchema.safeParse({
        ...validEvent,
        status: "not_recorded",
        references: ["unexpected"],
      }).success,
    ).toBe(false);
    expect(
      recordingEventSchema.safeParse({
        ...validEvent,
        status: "unknown",
        references: ["legacy-reference"],
      }).success,
    ).toBe(true);
  });

  it("rejects unknown receipt and event object keys", () => {
    expect(
      recordingReceiptInputSchema.safeParse({
        status: "unknown",
        references: [],
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      recordingEventSchema.safeParse({ ...validEvent, unexpected: true })
        .success,
    ).toBe(false);
  });

  it("validates recording artifacts with ISO datetimes", () => {
    const historyEntry = {
      eventId: validEvent.eventId,
      recordedAt: validEvent.recordedAt,
      idempotencyKey: validEvent.idempotencyKey,
      status: validEvent.status,
      references: validEvent.references,
    };
    const artifact = {
      schemaVersion: 2,
      subject: { kind: "run", id: "run-1" },
      current: {
        eventId: validEvent.eventId,
        status: validEvent.status,
        references: validEvent.references,
      },
      history: [historyEntry],
      materializedAt: validEvent.recordedAt,
    };
    expect(recordingArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(
      recordingArtifactSchema.safeParse({
        ...artifact,
        materializedAt: "not-a-datetime",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown artifact keys at the outer, current, and history levels", () => {
    const historyEntry = {
      eventId: validEvent.eventId,
      recordedAt: validEvent.recordedAt,
      idempotencyKey: validEvent.idempotencyKey,
      status: validEvent.status,
      references: validEvent.references,
    };
    const artifact = {
      schemaVersion: 2,
      subject: { kind: "run", id: "run-1" },
      current: {
        eventId: validEvent.eventId,
        status: validEvent.status,
        references: validEvent.references,
      },
      history: [historyEntry],
      materializedAt: validEvent.recordedAt,
    };

    expect(
      recordingArtifactSchema.safeParse({ ...artifact, unexpected: true })
        .success,
    ).toBe(false);
    expect(
      recordingArtifactSchema.safeParse({
        ...artifact,
        current: { ...artifact.current, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      recordingArtifactSchema.safeParse({
        ...artifact,
        history: [{ ...historyEntry, unexpected: true }],
      }).success,
    ).toBe(false);
  });
});
