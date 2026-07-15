import { describe, expect, it } from "vitest";
import {
  recordingArtifactSchema,
  recordingEventIdSchema,
  recordingEventSchema,
  recordingIdempotencyKeySchema,
  recordingReceiptInputSchema,
  recordingReferenceSchema,
} from "../../src/core/recording/schema.js";

const validEvent = {
  schemaVersion: 1,
  eventId: "recording-00000000-0000-0000-0000-000000000001",
  runId: "run-1",
  recordedAt: "2026-07-15T01:00:00.000Z",
  idempotencyKey: "receipt-1",
  status: "recorded",
  references: ["opaque-reference"],
} as const;

describe("recording repository schemas", () => {
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
      idempotencyKey: "receipt-1",
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
        idempotencyKey: "recorded-empty",
        status: "recorded",
        references: [],
      }).success,
    ).toBe(false);
    expect(
      recordingReceiptInputSchema.safeParse({
        idempotencyKey: "recorded-present",
        status: "recorded",
        references: ["ref"],
      }).success,
    ).toBe(true);
    expect(
      recordingReceiptInputSchema.safeParse({
        idempotencyKey: "not-recorded-empty",
        status: "not_recorded",
        references: [],
      }).success,
    ).toBe(true);
    expect(
      recordingReceiptInputSchema.safeParse({
        idempotencyKey: "not-recorded-present",
        status: "not_recorded",
        references: ["ref"],
      }).success,
    ).toBe(false);
  });

  it("accepts unknown receipts with empty or populated references", () => {
    for (const references of [[], ["known-reference"]]) {
      expect(
        recordingReceiptInputSchema.safeParse({
          idempotencyKey: "unknown-key",
          status: "unknown",
          references,
        }).success,
      ).toBe(true);
    }
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
  });

  it("rejects unknown receipt and event object keys", () => {
    expect(
      recordingReceiptInputSchema.safeParse({
        idempotencyKey: "strict-receipt",
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
    const artifact = {
      schemaVersion: 1,
      runId: "run-1",
      current: {
        eventId: validEvent.eventId,
        status: validEvent.status,
        references: validEvent.references,
      },
      history: [
        {
          eventId: validEvent.eventId,
          recordedAt: validEvent.recordedAt,
          idempotencyKey: validEvent.idempotencyKey,
          status: validEvent.status,
          references: validEvent.references,
        },
      ],
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
});
