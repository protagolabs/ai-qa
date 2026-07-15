import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeJsonLines } from "../../src/core/fs/json-lines.js";
import {
  classifyRecordingMaterialization,
  materializeRecordingArtifact,
  RecordingRepository,
} from "../../src/core/recording/repository.js";
import {
  recordingEventSchema,
  type RecordingArtifact,
  type RecordingEvent,
} from "../../src/core/recording/schema.js";

const FIRST_RECORDED_AT = "2026-07-15T01:00:00.000Z";
const SECOND_RECORDED_AT = "2026-07-15T01:05:00.000Z";

function recordingEvent(
  overrides: Partial<RecordingEvent> = {},
): RecordingEvent {
  return recordingEventSchema.parse({
    schemaVersion: 1,
    eventId: "recording-00000000-0000-0000-0000-000000000001",
    runId: "run-1",
    recordedAt: FIRST_RECORDED_AT,
    idempotencyKey: "receipt-1",
    status: "recorded",
    references: ["opaque-reference-1"],
    ...overrides,
  });
}

function twoEvents(): [RecordingEvent, RecordingEvent] {
  return [
    recordingEvent(),
    recordingEvent({
      eventId: "recording-00000000-0000-0000-0000-000000000002",
      recordedAt: SECOND_RECORDED_AT,
      idempotencyKey: "receipt-2",
      status: "unknown",
      references: ["opaque-reference-2"],
    }),
  ];
}

async function createDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-recording-"));
  const directory = join(root, ".ai-qa", "reports", "runs", "run-1");
  await mkdir(directory, { recursive: true });
  return directory;
}

async function writeJournal(
  directory: string,
  events: readonly RecordingEvent[],
): Promise<void> {
  await writeFile(
    join(directory, "recording.jsonl"),
    serializeJsonLines(events),
  );
}

async function writeArtifact(
  directory: string,
  artifact: RecordingArtifact,
): Promise<void> {
  await writeFile(
    join(directory, "recording.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
}

describe("recording repository materialization", () => {
  it("materializes journal order, final current state, and deterministic time", () => {
    const events = twoEvents();
    const artifact = materializeRecordingArtifact({
      runId: "run-1",
      events,
    });

    expect(artifact).toEqual({
      schemaVersion: 1,
      runId: "run-1",
      current: {
        eventId: events[1].eventId,
        status: events[1].status,
        references: events[1].references,
      },
      history: events.map(
        ({ eventId, recordedAt, idempotencyKey, status, references }) => ({
          eventId,
          recordedAt,
          idempotencyKey,
          status,
          references,
        }),
      ),
      materializedAt: SECOND_RECORDED_AT,
    });
  });

  it("rejects empty histories and run identity mismatches", () => {
    expect(() =>
      materializeRecordingArtifact({ runId: "run-1", events: [] }),
    ).toThrow();
    expect(() =>
      materializeRecordingArtifact({
        runId: "run-1",
        events: [recordingEvent({ runId: "run-2" })],
      }),
    ).toThrow();
  });

  it("classifies current, lagging, derived-only, ahead, and conflicting views", () => {
    const events = twoEvents();
    const current = materializeRecordingArtifact({
      runId: "run-1",
      events,
    });
    const lagging = materializeRecordingArtifact({
      runId: "run-1",
      events: [events[0]],
    });
    const derivedOnlyDifference: RecordingArtifact = {
      ...current,
      current: lagging.current,
      materializedAt: FIRST_RECORDED_AT,
    };
    const conflicting: RecordingArtifact = {
      ...current,
      history: current.history.map((entry, index) =>
        index === 0 ? { ...entry, idempotencyKey: "contradiction" } : entry,
      ),
    };

    expect(
      classifyRecordingMaterialization({ events, artifact: current }),
    ).toBe("current");
    expect(
      classifyRecordingMaterialization({ events, artifact: lagging }),
    ).toBe("recoverable");
    expect(
      classifyRecordingMaterialization({
        events,
        artifact: derivedOnlyDifference,
      }),
    ).toBe("recoverable");
    expect(
      classifyRecordingMaterialization({
        events: [events[0]],
        artifact: current,
      }),
    ).toBe("conflict");
    expect(
      classifyRecordingMaterialization({ events, artifact: conflicting }),
    ).toBe("conflict");
  });
});

describe("recording repository", () => {
  it("returns missing when neither canonical journal nor view exists", async () => {
    const directory = await createDirectory();
    const repository = new RecordingRepository(
      directory,
      "run-1",
      () => new Date(FIRST_RECORDED_AT),
    );

    await expect(repository.readOrRecoverUnlocked()).resolves.toEqual({
      state: "missing",
    });
  });

  it("registers events with a newline-terminated canonical journal", async () => {
    const directory = await createDirectory();
    const repository = new RecordingRepository(
      directory,
      "run-1",
      () => new Date(FIRST_RECORDED_AT),
    );

    const registered = await repository.registerUnlocked({
      idempotencyKey: "receipt-1",
      status: "recorded",
      references: ["opaque-reference-1"],
    });
    const journal = await readFile(join(directory, "recording.jsonl"), "utf8");

    expect(registered.replayed).toBe(false);
    expect(registered.event).toMatchObject({
      schemaVersion: 1,
      runId: "run-1",
      recordedAt: FIRST_RECORDED_AT,
      idempotencyKey: "receipt-1",
      status: "recorded",
      references: ["opaque-reference-1"],
    });
    expect(registered.event.eventId).toMatch(/^recording-/u);
    expect(journal.endsWith("\n")).toBe(true);
    expect(journal.slice(0, -1).split("\n")).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(directory, "recording.json"), "utf8")),
    ).toEqual(registered.artifact);
    expect(registered.artifact.materializedAt).toBe(FIRST_RECORDED_AT);
  });

  it("recovers the crash window without changing journal or collateral bytes", async () => {
    const directory = await createDirectory();
    const projectRoot = join(directory, "..", "..", "..", "..");
    const runDirectory = join(projectRoot, ".ai-qa", "runs", "run-1");
    await mkdir(runDirectory, { recursive: true });
    const event = recordingEvent();
    await writeJournal(directory, [event]);
    const collateral = new Map<string, string>([
      [join(directory, "report.json"), '{"report":"bytes"}\n'],
      [join(directory, "report.md"), "# Report bytes\n"],
      [join(runDirectory, "events.jsonl"), '{"run":"event"}\n'],
      [join(runDirectory, "verdict.json"), '{"verdict":"pass"}\n'],
      [join(projectRoot, "external-state.txt"), "external state\n"],
    ]);
    for (const [path, bytes] of collateral) await writeFile(path, bytes);
    const journalPath = join(directory, "recording.jsonl");
    const journalBefore = await readFile(journalPath, "utf8");
    const journalStatBefore = await stat(journalPath);
    let nowCalls = 0;
    const repository = new RecordingRepository(directory, "run-1", () => {
      nowCalls += 1;
      return new Date(SECOND_RECORDED_AT);
    });

    const recovered = await repository.readOrRecoverUnlocked();

    expect(recovered).toEqual({
      state: "present",
      events: [event],
      artifact: materializeRecordingArtifact({
        runId: "run-1",
        events: [event],
      }),
    });
    expect(
      JSON.parse(await readFile(join(directory, "recording.json"), "utf8")),
    ).toEqual(
      materializeRecordingArtifact({ runId: "run-1", events: [event] }),
    );
    expect(nowCalls).toBe(0);
    expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
    const journalStatAfterRecovery = await stat(journalPath);
    expect(journalStatAfterRecovery.ino).toBe(journalStatBefore.ino);
    for (const [path, bytes] of collateral) {
      expect(await readFile(path, "utf8")).toBe(bytes);
    }

    const retry = await repository.registerUnlocked({
      idempotencyKey: event.idempotencyKey,
      status: event.status,
      references: event.references,
    });
    expect(retry).toEqual({
      event,
      artifact: materializeRecordingArtifact({
        runId: "run-1",
        events: [event],
      }),
      replayed: true,
    });
    expect(nowCalls).toBe(0);
    expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
    expect((await stat(journalPath)).ino).toBe(journalStatBefore.ino);
  });

  it("recovers a one-event-lagging materialized view without rewriting the journal", async () => {
    const directory = await createDirectory();
    const events = twoEvents();
    await writeJournal(directory, events);
    await writeArtifact(
      directory,
      materializeRecordingArtifact({ runId: "run-1", events: [events[0]] }),
    );
    const journalPath = join(directory, "recording.jsonl");
    const journalBefore = await readFile(journalPath, "utf8");
    const journalInode = (await stat(journalPath)).ino;
    const repository = new RecordingRepository(
      directory,
      "run-1",
      () => new Date("2099-01-01T00:00:00.000Z"),
    );

    const recovered = await repository.readOrRecoverUnlocked();

    expect(recovered).toEqual({
      state: "present",
      events,
      artifact: materializeRecordingArtifact({ runId: "run-1", events }),
    });
    expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
    expect((await stat(journalPath)).ino).toBe(journalInode);
  });

  it("recovers an invalid materialized view from a valid journal", async () => {
    const directory = await createDirectory();
    const event = recordingEvent();
    await writeJournal(directory, [event]);
    await writeFile(join(directory, "recording.json"), "{");
    const repository = new RecordingRepository(
      directory,
      "run-1",
      () => new Date("2099-01-01T00:00:00.000Z"),
    );

    await expect(repository.readOrRecoverUnlocked()).resolves.toEqual({
      state: "present",
      events: [event],
      artifact: materializeRecordingArtifact({
        runId: "run-1",
        events: [event],
      }),
    });
  });

  it("rejects an artifact without its canonical journal", async () => {
    const directory = await createDirectory();
    await writeArtifact(
      directory,
      materializeRecordingArtifact({
        runId: "run-1",
        events: [recordingEvent()],
      }),
    );
    const repository = new RecordingRepository(
      directory,
      "run-1",
      () => new Date(FIRST_RECORDED_AT),
    );

    await expect(repository.readOrRecoverUnlocked()).rejects.toMatchObject({
      code: "recording.integrity_error",
    });
  });

  it("rejects malformed, empty, non-terminated, mismatched, and ambiguous journals", async () => {
    const valid = recordingEvent();
    const invalidJournals = [
      "{not-json}\n",
      "",
      JSON.stringify(valid),
      serializeJsonLines([recordingEvent({ runId: "run-2" })]),
      serializeJsonLines([
        valid,
        recordingEvent({
          eventId: "recording-00000000-0000-0000-0000-000000000002",
          recordedAt: SECOND_RECORDED_AT,
        }),
      ]),
    ];

    for (const content of invalidJournals) {
      const directory = await createDirectory();
      await writeFile(join(directory, "recording.jsonl"), content);
      const repository = new RecordingRepository(
        directory,
        "run-1",
        () => new Date(FIRST_RECORDED_AT),
      );
      await expect(repository.readOrRecoverUnlocked()).rejects.toMatchObject({
        code: "recording.integrity_error",
      });
    }
  });

  it("rejects a valid materialized view with a different run identity", async () => {
    const directory = await createDirectory();
    const event = recordingEvent();
    await writeJournal(directory, [event]);
    const otherRunEvent = recordingEvent({ runId: "run-2" });
    await writeArtifact(
      directory,
      materializeRecordingArtifact({
        runId: "run-2",
        events: [otherRunEvent],
      }),
    );
    const repository = new RecordingRepository(
      directory,
      "run-1",
      () => new Date(FIRST_RECORDED_AT),
    );

    await expect(repository.readOrRecoverUnlocked()).rejects.toMatchObject({
      code: "recording.integrity_error",
    });
  });

  it("rejects ahead and shared-history-conflicting materialized views", async () => {
    const events = twoEvents();
    const aheadDirectory = await createDirectory();
    await writeJournal(aheadDirectory, [events[0]]);
    await writeArtifact(
      aheadDirectory,
      materializeRecordingArtifact({ runId: "run-1", events }),
    );

    const conflictingDirectory = await createDirectory();
    await writeJournal(conflictingDirectory, events);
    const artifact = materializeRecordingArtifact({ runId: "run-1", events });
    const [firstHistory, secondHistory] = artifact.history;
    if (firstHistory === undefined || secondHistory === undefined) {
      throw new Error("Two-event materialization requires two history entries");
    }
    await writeArtifact(conflictingDirectory, {
      ...artifact,
      history: [secondHistory, firstHistory],
    });

    for (const directory of [aheadDirectory, conflictingDirectory]) {
      const repository = new RecordingRepository(
        directory,
        "run-1",
        () => new Date(FIRST_RECORDED_AT),
      );
      await expect(repository.readOrRecoverUnlocked()).rejects.toMatchObject({
        code: "recording.integrity_error",
      });
    }
  });

  it("replays exact payloads without journal writes and rejects key reuse conflicts", async () => {
    const directory = await createDirectory();
    const repository = new RecordingRepository(
      directory,
      "run-1",
      () => new Date(FIRST_RECORDED_AT),
    );
    const receipt = {
      idempotencyKey: "stable-key",
      status: "recorded" as const,
      references: ["ref-a", "ref-b"],
    };
    const first = await repository.registerUnlocked(receipt);
    const journalPath = join(directory, "recording.jsonl");
    const journalBefore = await readFile(journalPath, "utf8");
    const journalInode = (await stat(journalPath)).ino;

    await expect(repository.registerUnlocked(receipt)).resolves.toEqual({
      event: first.event,
      artifact: first.artifact,
      replayed: true,
    });
    expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
    expect((await stat(journalPath)).ino).toBe(journalInode);

    for (const conflict of [
      { ...receipt, status: "unknown" as const },
      { ...receipt, references: ["ref-b", "ref-a"] },
    ]) {
      await expect(repository.registerUnlocked(conflict)).rejects.toMatchObject(
        {
          code: "recording.idempotency_conflict",
          details: { idempotencyKey: "stable-key" },
        },
      );
      expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
      expect((await stat(journalPath)).ino).toBe(journalInode);
    }
  });
});
