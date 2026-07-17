import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { writeProjectConfig } from "../../src/core/config/repository.js";
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
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  type WorkOrder,
} from "../../src/core/runs/schema.js";
import {
  generateRunReport,
  type ReportOperationInput,
} from "../../src/services/report-generation/generate-run-report.js";
import {
  readRecordingStatus,
  registerRecordingReceipt,
} from "../../src/services/report-generation/recording-receipt.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { cancelRun } from "../../src/services/run-protocol/run-lifecycle.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import {
  initializeTestProject,
  projectConfig,
} from "../helpers/project-fixture.js";

const FIRST_RECORDED_AT = "2026-07-15T01:00:00.000Z";
const SECOND_RECORDED_AT = "2026-07-15T01:05:00.000Z";
const RUN_SUBJECT = { kind: "run", id: "run-1" } as const;

function recordingEvent(
  overrides: Partial<RecordingEvent> = {},
): RecordingEvent {
  return recordingEventSchema.parse({
    schemaVersion: 2,
    eventId: "recording-00000000-0000-0000-0000-000000000001",
    subject: RUN_SUBJECT,
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
  await writeRawArtifact(directory, artifact);
}

async function writeRawArtifact(
  directory: string,
  artifact: unknown,
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
      subject: { kind: "run", id: "run-1" },
      events,
    });

    expect(artifact).toEqual({
      schemaVersion: 2,
      subject: { kind: "run", id: "run-1" },
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
      materializeRecordingArtifact({ subject: { kind: "run", id: "run-1" }, events: [] }),
    ).toThrow();
    expect(() =>
      materializeRecordingArtifact({
        subject: { kind: "run", id: "run-1" },
        events: [recordingEvent({ subject: { kind: "run", id: "run-2" } })],
      }),
    ).toThrow();
  });

  it("classifies current, lagging, derived-only, ahead, and conflicting views", () => {
    const events = twoEvents();
    const current = materializeRecordingArtifact({
      subject: { kind: "run", id: "run-1" },
      events,
    });
    const lagging = materializeRecordingArtifact({
      subject: { kind: "run", id: "run-1" },
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

  it("classifies a different artifact run identity as conflict", () => {
    const events = twoEvents();
    const artifact = materializeRecordingArtifact({
      subject: { kind: "run", id: "run-1" },
      events,
    });

    expect(
      classifyRecordingMaterialization({
        events,
        artifact: { ...artifact, subject: { kind: "run", id: "run-2" } },
      }),
    ).toBe("conflict");
  });
});

describe("recording repository", () => {
  it("returns missing when neither canonical journal nor view exists", async () => {
    const directory = await createDirectory();
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
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
      RUN_SUBJECT,
      () => new Date(FIRST_RECORDED_AT),
    );

    const registered = await repository.registerUnlocked({
      status: "recorded",
      references: ["opaque-reference-1"],
    });
    const journal = await readFile(join(directory, "recording.jsonl"), "utf8");

    expect(registered.replayed).toBe(false);
    expect(registered.event).toMatchObject({
      schemaVersion: 2,
      subject: { kind: "run", id: "run-1" },
      recordedAt: FIRST_RECORDED_AT,
      idempotencyKey: expect.stringMatching(/^recording:sha256:[a-f0-9]{64}:v2$/u),
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

  it.each(["recording.jsonl", "recording.json"])(
    "rejects a symlinked %s without following or replacing its target",
    async (filename) => {
      const directory = await createDirectory();
      const outside = await mkdtemp(join(tmpdir(), "ai-qa-recording-outside-"));
      const outsidePath = join(outside, filename);
      const outsideBytes = `outside ${filename} bytes\n`;
      if (filename === "recording.json") {
        await writeJournal(directory, [recordingEvent()]);
      }
      await writeFile(outsidePath, outsideBytes);
      await symlink(outsidePath, join(directory, filename));
      const repository = new RecordingRepository(
        directory,
        RUN_SUBJECT,
        () => new Date(FIRST_RECORDED_AT),
      );

      await expect(repository.readOrRecoverUnlocked()).rejects.toMatchObject({
        code: "recording.integrity_error",
      });
      await expect(
        repository.registerUnlocked({
          status: "unknown",
          references: [],
        }),
      ).rejects.toMatchObject({ code: "recording.integrity_error" });
      expect(await readFile(outsidePath, "utf8")).toBe(outsideBytes);
    },
  );

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
    const repository = new RecordingRepository(directory, RUN_SUBJECT, () => {
      nowCalls += 1;
      return new Date(SECOND_RECORDED_AT);
    });

    const recovered = await repository.readOrRecoverUnlocked();

    expect(recovered).toEqual({
      state: "present",
      events: [event],
      artifact: materializeRecordingArtifact({
        subject: { kind: "run", id: "run-1" },
        events: [event],
      }),
    });
    expect(
      JSON.parse(await readFile(join(directory, "recording.json"), "utf8")),
    ).toEqual(
      materializeRecordingArtifact({ subject: { kind: "run", id: "run-1" }, events: [event] }),
    );
    expect(nowCalls).toBe(0);
    expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
    const journalStatAfterRecovery = await stat(journalPath);
    expect(journalStatAfterRecovery.ino).toBe(journalStatBefore.ino);
    for (const [path, bytes] of collateral) {
      expect(await readFile(path, "utf8")).toBe(bytes);
    }

    const retry = await repository.registerUnlocked({
      status: event.status,
      references: event.references,
    });
    expect(retry).toEqual({
      event,
      artifact: materializeRecordingArtifact({
        subject: { kind: "run", id: "run-1" },
        events: [event],
      }),
      replayed: true,
    });
    expect(nowCalls).toBe(0);
    expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
    expect((await stat(journalPath)).ino).toBe(journalStatBefore.ino);
  });

  it("reads and recovers a stored unknown event with references", async () => {
    const directory = await createDirectory();
    const event: RecordingEvent = {
      schemaVersion: 2,
      eventId: "recording-00000000-0000-0000-0000-000000000003",
      subject: RUN_SUBJECT,
      recordedAt: FIRST_RECORDED_AT,
      idempotencyKey: "legacy-unknown-receipt",
      status: "unknown",
      references: ["legacy-opaque-reference"],
    };
    await writeJournal(directory, [event]);
    const journalPath = join(directory, "recording.jsonl");
    const journalBefore = await readFile(journalPath, "utf8");
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
      () => new Date(SECOND_RECORDED_AT),
    );
    const expectedArtifact: RecordingArtifact = {
      schemaVersion: 2,
      subject: { kind: "run", id: "run-1" },
      current: {
        eventId: event.eventId,
        status: event.status,
        references: event.references,
      },
      history: [
        {
          eventId: event.eventId,
          recordedAt: event.recordedAt,
          idempotencyKey: event.idempotencyKey,
          status: event.status,
          references: event.references,
        },
      ],
      materializedAt: event.recordedAt,
    };

    await expect(repository.readOrRecoverUnlocked()).resolves.toEqual({
      state: "present",
      events: [event],
      artifact: expectedArtifact,
    });
    expect(
      JSON.parse(await readFile(join(directory, "recording.json"), "utf8")),
    ).toEqual(expectedArtifact);
    expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
  });

  it("recovers a one-event-lagging materialized view without rewriting the journal", async () => {
    const directory = await createDirectory();
    const events = twoEvents();
    await writeJournal(directory, events);
    await writeArtifact(
      directory,
      materializeRecordingArtifact({ subject: { kind: "run", id: "run-1" }, events: [events[0]] }),
    );
    const journalPath = join(directory, "recording.jsonl");
    const journalBefore = await readFile(journalPath, "utf8");
    const journalInode = (await stat(journalPath)).ino;
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
      () => new Date("2099-01-01T00:00:00.000Z"),
    );

    const recovered = await repository.readOrRecoverUnlocked();
    const expected = materializeRecordingArtifact({
      subject: { kind: "run", id: "run-1" },
      events,
    });

    expect(recovered).toEqual({
      state: "present",
      events,
      artifact: expected,
    });
    expect(
      JSON.parse(await readFile(join(directory, "recording.json"), "utf8")),
    ).toEqual(expected);
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
      RUN_SUBJECT,
      () => new Date("2099-01-01T00:00:00.000Z"),
    );
    const expected = materializeRecordingArtifact({
      subject: { kind: "run", id: "run-1" },
      events: [event],
    });

    await expect(repository.readOrRecoverUnlocked()).resolves.toEqual({
      state: "present",
      events: [event],
      artifact: expected,
    });
    expect(
      JSON.parse(await readFile(join(directory, "recording.json"), "utf8")),
    ).toEqual(expected);
  });

  it("rewrites a schema-invalid artifact with extras when journal history authorizes recovery", async () => {
    const directory = await createDirectory();
    const event = recordingEvent();
    await writeJournal(directory, [event]);
    const expected = materializeRecordingArtifact({
      subject: { kind: "run", id: "run-1" },
      events: [event],
    });
    const [entry] = expected.history;
    if (entry === undefined) throw new Error("Expected one history entry");
    await writeRawArtifact(directory, {
      ...expected,
      unexpected: true,
      current: { ...expected.current, unexpected: true },
      history: [{ ...entry, unexpected: true }],
    });
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
      () => new Date("2099-01-01T00:00:00.000Z"),
    );

    await expect(repository.readOrRecoverUnlocked()).resolves.toEqual({
      state: "present",
      events: [event],
      artifact: expected,
    });
    expect(await readFile(join(directory, "recording.json"), "utf8")).toBe(
      `${JSON.stringify(expected, null, 2)}\n`,
    );
  });

  it("rejects a recognizable wrong run even when another artifact field is schema-invalid", async () => {
    const directory = await createDirectory();
    const event = recordingEvent();
    await writeJournal(directory, [event]);
    const expected = materializeRecordingArtifact({
      subject: { kind: "run", id: "run-1" },
      events: [event],
    });
    const contradictory = {
      ...expected,
      subject: { kind: "run", id: "run-2" },
      materializedAt: "not-a-datetime",
    };
    const bytes = `${JSON.stringify(contradictory, null, 2)}\n`;
    await writeRawArtifact(directory, contradictory);
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
      () => new Date(FIRST_RECORDED_AT),
    );

    await expect(repository.readOrRecoverUnlocked()).rejects.toMatchObject({
      code: "recording.integrity_error",
    });
    expect(await readFile(join(directory, "recording.json"), "utf8")).toBe(
      bytes,
    );
  });

  it("rejects recognizable ahead history even when the extra entry is malformed", async () => {
    const directory = await createDirectory();
    const event = recordingEvent();
    await writeJournal(directory, [event]);
    const expected = materializeRecordingArtifact({
      subject: { kind: "run", id: "run-1" },
      events: [event],
    });
    const ahead = {
      ...expected,
      history: [...expected.history, { malformed: true }],
    };
    const bytes = `${JSON.stringify(ahead, null, 2)}\n`;
    await writeRawArtifact(directory, ahead);
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
      () => new Date(FIRST_RECORDED_AT),
    );

    await expect(repository.readOrRecoverUnlocked()).rejects.toMatchObject({
      code: "recording.integrity_error",
    });
    expect(await readFile(join(directory, "recording.json"), "utf8")).toBe(
      bytes,
    );
  });

  it("rejects a recognizable shared-event contradiction in a schema-invalid artifact", async () => {
    const directory = await createDirectory();
    const event = recordingEvent();
    await writeJournal(directory, [event]);
    const expected = materializeRecordingArtifact({
      subject: { kind: "run", id: "run-1" },
      events: [event],
    });
    const [entry] = expected.history;
    if (entry === undefined) throw new Error("Expected one history entry");
    const contradictory = {
      ...expected,
      history: [{ ...entry, idempotencyKey: "different-key" }],
      materializedAt: "not-a-datetime",
    };
    const bytes = `${JSON.stringify(contradictory, null, 2)}\n`;
    await writeRawArtifact(directory, contradictory);
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
      () => new Date(FIRST_RECORDED_AT),
    );

    await expect(repository.readOrRecoverUnlocked()).rejects.toMatchObject({
      code: "recording.integrity_error",
    });
    expect(await readFile(join(directory, "recording.json"), "utf8")).toBe(
      bytes,
    );
  });

  it("maps an overflowing number in a recognized history field to stable integrity failure", async () => {
    const directory = await createDirectory();
    const event = recordingEvent();
    await writeJournal(directory, [event]);
    const expected = materializeRecordingArtifact({
      subject: { kind: "run", id: "run-1" },
      events: [event],
    });
    const canonicalBytes = `${JSON.stringify(expected, null, 2)}\n`;
    const unsafeBytes = canonicalBytes.replace(
      '"idempotencyKey": "receipt-1"',
      '"idempotencyKey": 1e400',
    );
    if (unsafeBytes === canonicalBytes) {
      throw new Error("Expected to inject an overflowing JSON number");
    }
    await writeFile(join(directory, "recording.json"), unsafeBytes);
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
      () => new Date(FIRST_RECORDED_AT),
    );

    await expect(repository.readOrRecoverUnlocked()).rejects.toMatchObject({
      code: "recording.integrity_error",
    });
    expect(await readFile(join(directory, "recording.json"), "utf8")).toBe(
      unsafeBytes,
    );
  });

  it("rejects an artifact without its canonical journal", async () => {
    const directory = await createDirectory();
    await writeArtifact(
      directory,
      materializeRecordingArtifact({
        subject: { kind: "run", id: "run-1" },
        events: [recordingEvent()],
      }),
    );
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
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
      serializeJsonLines([recordingEvent({ subject: { kind: "run", id: "run-2" } })]),
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
        RUN_SUBJECT,
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
    const otherRunEvent = recordingEvent({ subject: { kind: "run", id: "run-2" } });
    await writeArtifact(
      directory,
      materializeRecordingArtifact({
        subject: { kind: "run", id: "run-2" },
        events: [otherRunEvent],
      }),
    );
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
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
      materializeRecordingArtifact({ subject: { kind: "run", id: "run-1" }, events }),
    );

    const conflictingDirectory = await createDirectory();
    await writeJournal(conflictingDirectory, events);
    const artifact = materializeRecordingArtifact({ subject: { kind: "run", id: "run-1" }, events });
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
        RUN_SUBJECT,
        () => new Date(FIRST_RECORDED_AT),
      );
      await expect(repository.readOrRecoverUnlocked()).rejects.toMatchObject({
        code: "recording.integrity_error",
      });
    }
  });

  it("derives receipt identity, replays exact payloads without journal writes, and rejects conflicts", async () => {
    const directory = await createDirectory();
    const repository = new RecordingRepository(
      directory,
      RUN_SUBJECT,
      () => new Date(FIRST_RECORDED_AT),
    );
    const receipt = {
      status: "recorded" as const,
      references: ["ref-a", "ref-b"],
    };
    const first = await repository.registerUnlocked(receipt);
    expect(first.event.idempotencyKey).toMatch(
      /^recording:sha256:[a-f0-9]{64}:v2$/u,
    );
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
      { status: "unknown" as const, references: [] },
      { ...receipt, references: ["ref-b", "ref-a"] },
    ]) {
      await expect(repository.registerUnlocked(conflict)).rejects.toMatchObject(
        {
          code: "recording.idempotency_conflict",
          details: { runId: "run-1" },
        },
      );
      expect(await readFile(journalPath, "utf8")).toBe(journalBefore);
      expect((await stat(journalPath)).ino).toBe(journalInode);
    }
  });
});

const RUN_STARTED_AT = new Date("2026-07-15T00:00:00.000Z");
const RUN_NOW = () => new Date("2026-07-15T00:05:00.000Z");
const REPORT_NOW = () => new Date("2026-07-15T00:10:00.000Z");
const RECEIPT_NOW = () => new Date(FIRST_RECORDED_AT);
const PROJECT_SKILL_RELATIVE_PATH =
  ".agents/skills/ai-qa-project/SKILL.md" as const;

interface ReceiptFixture extends ReportOperationInput {
  directory: string;
  evidencePath?: string;
}

function withoutRecordingSnapshot(workOrder: WorkOrder): WorkOrder {
  const legacyWorkOrder: WorkOrder = { ...workOrder };
  delete legacyWorkOrder.recordingPolicy;
  return legacyWorkOrder;
}

function withoutProjectSkillSnapshot(workOrder: WorkOrder): WorkOrder {
  const historicalWorkOrder: WorkOrder = {
    ...workOrder,
    protocolVersion: "1.1.0",
  };
  delete historicalWorkOrder.projectSkill;
  return historicalWorkOrder;
}

async function receiptFixture(
  options: {
    mode?: "local-only" | "project-skill";
    legacy?: boolean;
    historicalProjectSkill?: boolean;
    terminal?: boolean;
    generated?: boolean;
    withEvidence?: boolean;
  } = {},
): Promise<ReceiptFixture> {
  const mode = options.mode ?? "project-skill";
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-receipt-project-"));
  await initializeTestProject({
    projectRoot,
    config: projectConfig(["web"], mode),
  });
  const projectSkillPath = join(projectRoot, PROJECT_SKILL_RELATIVE_PATH);
  const projectSkillContent = await readFile(projectSkillPath, "utf8");
  const repository = new RunRepository(projectRoot, RUN_NOW);
  const currentWorkOrder = createExploratoryWorkOrder({
    platform: "web",
    projectId: "sample-web",
    runId: "run-1",
    input: exploratoryRunInputSchema.parse({
      goal: "Explore the receipt boundary",
      acceptanceCriteria: [
        {
          id: "flow-reviewed",
          description: "The flow is reviewed",
          requiredEvidence: ["screenshot"],
        },
      ],
      readiness: { platform: "web", status: "ready", checks: [] },
    }),
    evidencePolicy: {
      screenshots: "required",
      defaultSensitivity: "internal",
    },
    recordingPolicy: { mode },
    ...(mode === "project-skill"
      ? {
          projectSkill: {
            path: PROJECT_SKILL_RELATIVE_PATH,
            contentSha256: createHash("sha256")
              .update(projectSkillContent)
              .digest("hex"),
          },
        }
      : {}),
    startedAt: RUN_STARTED_AT,
  });
  const workOrder =
    options.legacy === true
      ? withoutRecordingSnapshot(currentWorkOrder)
      : options.historicalProjectSkill === true
        ? withoutProjectSkillSnapshot(currentWorkOrder)
        : currentWorkOrder;
  await repository.create(workOrder);

  let evidencePath: string | undefined;
  if (options.withEvidence === true) {
    const protocol = new RunProtocolService(projectRoot, "run-1", RUN_NOW);
    const capture = await protocol.planAction({
      idempotencyKey: "capture-before-cancel",
      kind: "evidence-capture",
      intent: "Capture state before cancellation",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    await protocol.completeAction({
      actionId: capture.id,
      phase: "completed",
      toolResult: { summary: "Screenshot captured" },
    });
    const sourcePath = join(projectRoot, "capture.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
    const evidence = await registerEvidence({
      projectRoot,
      runId: "run-1",
      payload: {
        sourcePath,
        mediaType: "image/png",
        sourceTool: "chrome-devtools-mcp",
        sensitivity: "internal",
        evidenceKinds: ["screenshot"],
        captureActionId: capture.id,
        idempotencyKey: "evidence-before-cancel",
      },
      criterionIds: [],
      observationIds: [],
      now: RUN_NOW,
    });
    evidencePath = join(projectRoot, evidence.projectRelativePath);
  }

  if (options.terminal !== false) {
    await cancelRun({
      projectRoot,
      runId: "run-1",
      reason: "Receipt boundary fixture completed",
      now: RUN_NOW,
    });
  }
  if (options.generated !== false && options.terminal !== false) {
    await generateRunReport({
      projectRoot,
      runId: "run-1",
      now: REPORT_NOW,
    });
  }
  return {
    projectRoot,
    runId: "run-1",
    now: RECEIPT_NOW,
    directory: join(projectRoot, ".ai-qa/reports/runs/run-1"),
    ...(evidencePath === undefined ? {} : { evidencePath }),
  };
}

async function expectNoRecordingFiles(fixture: ReceiptFixture): Promise<void> {
  for (const filename of ["recording.jsonl", "recording.json"]) {
    await expect(
      readFile(join(fixture.directory, filename)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("verified report recording receipt service", () => {
  it("keeps local-only status not applicable without touching recording storage", async () => {
    const fixture = await receiptFixture({ mode: "local-only" });
    await rm(join(fixture.projectRoot, PROJECT_SKILL_RELATIVE_PATH));

    await expect(readRecordingStatus(fixture)).resolves.toEqual({
      subject: RUN_SUBJECT,
      status: "not_applicable",
      references: [],
    });
    await expect(
      registerRecordingReceipt({
        ...fixture,
        receipt: {
          status: "not_recorded",
          references: [],
        },
      }),
    ).rejects.toMatchObject({ code: "recording.not_applicable" });
    await expectNoRecordingFiles(fixture);
  });

  it("maps an absent project-skill receipt repository to pending only after report verification", async () => {
    const fixture = await receiptFixture();

    await expect(readRecordingStatus(fixture)).resolves.toEqual({
      subject: RUN_SUBJECT,
      status: "pending",
      references: [],
    });
    await expectNoRecordingFiles(fixture);
  });

  it("preserves terminal lifecycle validation before receipt registration", async () => {
    const fixture = await receiptFixture({ terminal: false, generated: false });

    await expect(readRecordingStatus(fixture)).rejects.toMatchObject({
      code: "report.run_not_terminal",
    });
    await expect(
      registerRecordingReceipt({
        ...fixture,
        receipt: {
          status: "unknown",
          references: [],
        },
      }),
    ).rejects.toMatchObject({ code: "report.run_not_terminal" });
    await expectNoRecordingFiles(fixture);
  });

  it("returns report.not_generated for terminal registration and status before generation", async () => {
    const fixture = await receiptFixture({ generated: false });

    await expect(readRecordingStatus(fixture)).rejects.toMatchObject({
      code: "report.not_generated",
    });
    await expect(
      registerRecordingReceipt({
        ...fixture,
        receipt: {
          status: "not_recorded",
          references: [],
        },
      }),
    ).rejects.toMatchObject({ code: "report.not_generated" });
    await expectNoRecordingFiles(fixture);
  });

  it("rejects report and evidence drift before creating recording files", async () => {
    const reportFixture = await receiptFixture();
    const reportPath = join(reportFixture.directory, "report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      verdict: { summary: string };
    };
    report.verdict.summary = "tampered receipt prerequisite";
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(
      join(reportFixture.projectRoot, PROJECT_SKILL_RELATIVE_PATH),
      "changed while the report is also invalid\n",
    );
    await expect(
      registerRecordingReceipt({
        ...reportFixture,
        receipt: {
          status: "unknown",
          references: [],
        },
      }),
    ).rejects.toMatchObject({ code: "report.integrity_error" });
    await expect(readRecordingStatus(reportFixture)).rejects.toMatchObject({
      code: "report.integrity_error",
    });
    await expectNoRecordingFiles(reportFixture);

    const evidenceFixture = await receiptFixture({ withEvidence: true });
    if (evidenceFixture.evidencePath === undefined) {
      throw new Error("Expected evidence-backed receipt fixture");
    }
    await writeFile(evidenceFixture.evidencePath, Buffer.from([9, 9, 9]));
    await expect(
      registerRecordingReceipt({
        ...evidenceFixture,
        receipt: {
          status: "unknown",
          references: [],
        },
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
    await expect(readRecordingStatus(evidenceFixture)).rejects.toMatchObject({
      code: "evidence.integrity_error",
    });
    await expectNoRecordingFiles(evidenceFixture);

    const storageFixture = await receiptFixture();
    const storedReport = join(storageFixture.directory, "report.json");
    const movedReport = join(
      await mkdtemp(join(tmpdir(), "ai-qa-receipt-outside-")),
      "report.json",
    );
    await rename(storedReport, movedReport);
    await symlink(movedReport, storedReport, "file");
    await expect(readRecordingStatus(storageFixture)).rejects.toMatchObject({
      code: "report.storage_integrity_error",
    });
    await expectNoRecordingFiles(storageFixture);
  });

  it("registers a single receipt with retry, conflict, status, and opaque references", async () => {
    const fixture = await receiptFixture();
    const opaqueReferences = [
      "docs/qa-results.md#run-1",
      "row:42",
      "message:abc",
    ];
    const recordedReceipt = {
      status: "recorded" as const,
      references: opaqueReferences,
    };
    const first = await registerRecordingReceipt({
      ...fixture,
      receipt: recordedReceipt,
    });

    expect(first.replayed).toBe(false);
    expect(first.status).toEqual({
      subject: RUN_SUBJECT,
      status: "recorded",
      references: opaqueReferences,
      eventId: first.event.eventId,
      recordedAt: FIRST_RECORDED_AT,
    });
    await expect(
      registerRecordingReceipt({ ...fixture, receipt: recordedReceipt }),
    ).resolves.toEqual({ ...first, replayed: true });
    await expect(
      registerRecordingReceipt({
        ...fixture,
        receipt: { status: "unknown", references: [] },
      }),
    ).rejects.toMatchObject({
      code: "recording.idempotency_conflict",
      details: { runId: "run-1" },
    });
    await expect(readRecordingStatus(fixture)).resolves.toEqual(first.status);
    const artifact = JSON.parse(
      await readFile(join(fixture.directory, "recording.json"), "utf8"),
    ) as RecordingArtifact;
    expect(artifact.history.map(({ status }) => status)).toEqual(["recorded"]);
    expect(artifact.current).toEqual({
      eventId: first.event.eventId,
      status: "recorded",
      references: opaqueReferences,
    });
  });

  it("rejects Project Skill drift without changing report, journal, verdict, or recording bytes", async () => {
    const fixture = await receiptFixture();
    const reportJsonPath = join(fixture.directory, "report.json");
    const paths = [
      reportJsonPath,
      join(fixture.directory, "report.md"),
      join(fixture.projectRoot, ".ai-qa/runs/run-1/events.jsonl"),
    ];
    const before = new Map(
      await Promise.all(
        paths.map(async (path) => {
          const bytes = await readFile(path);
          return [path, { bytes, hash: hashBytes(bytes) }] as const;
        }),
      ),
    );
    const verdictBefore = JSON.stringify(
      (
        JSON.parse(await readFile(reportJsonPath, "utf8")) as {
          verdict: unknown;
        }
      ).verdict,
    );
    await writeFile(
      join(fixture.projectRoot, PROJECT_SKILL_RELATIVE_PATH),
      "changed Project Skill bytes\n",
    );

    await expect(readRecordingStatus(fixture)).rejects.toMatchObject({
      code: "project_skill.changed",
    });
    await expect(
      registerRecordingReceipt({
        ...fixture,
        receipt: {
          status: "recorded",
          references: ["docs/qa-results.md#run-1"],
        },
      }),
    ).rejects.toMatchObject({ code: "project_skill.changed" });

    for (const path of paths) {
      const current = await readFile(path);
      expect(current).toEqual(before.get(path)?.bytes);
      expect(hashBytes(current)).toBe(before.get(path)?.hash);
    }
    const verdictAfter = JSON.stringify(
      (
        JSON.parse(await readFile(reportJsonPath, "utf8")) as {
          verdict: unknown;
        }
      ).verdict,
    );
    expect(verdictAfter).toBe(verdictBefore);
    await expectNoRecordingFiles(fixture);
  });

  it("rejects pending status and new receipts for historical 1.1 project-skill runs without a snapshot", async () => {
    const fixture = await receiptFixture({ historicalProjectSkill: true });

    await expect(readRecordingStatus(fixture)).rejects.toMatchObject({
      code: "project_skill.snapshot_missing",
    });
    await expect(
      registerRecordingReceipt({
        ...fixture,
        receipt: {
          status: "recorded",
          references: ["docs/qa-results.md#run-1"],
        },
      }),
    ).rejects.toMatchObject({ code: "project_skill.snapshot_missing" });
    await expectNoRecordingFiles(fixture);
  });

  it("reads and exactly replays an existing receipt for historical 1.1 project-skill runs", async () => {
    const fixture = await receiptFixture({ historicalProjectSkill: true });
    const receipt = {
      status: "recorded" as const,
      references: ["docs/qa-results.md#run-1"],
    };
    const historicalEvent = recordingEvent({
      subject: { kind: "run", id: fixture.runId },
      idempotencyKey: "historical-caller-owned-key",
      status: receipt.status,
      references: receipt.references,
    });
    await writeJournal(fixture.directory, [historicalEvent]);
    await writeArtifact(
      fixture.directory,
      materializeRecordingArtifact({
        subject: { kind: "run", id: fixture.runId },
        events: [historicalEvent],
      }),
    );
    const journalPath = join(fixture.directory, "recording.jsonl");
    const journalBefore = await readFile(journalPath);

    await expect(readRecordingStatus(fixture)).resolves.toEqual({
      subject: RUN_SUBJECT,
      status: "recorded",
      references: receipt.references,
      eventId: historicalEvent.eventId,
      recordedAt: historicalEvent.recordedAt,
    });
    await expect(
      registerRecordingReceipt({ ...fixture, receipt }),
    ).resolves.toEqual({
      event: historicalEvent,
      status: {
        subject: RUN_SUBJECT,
        status: "recorded",
        references: receipt.references,
        eventId: historicalEvent.eventId,
        recordedAt: historicalEvent.recordedAt,
      },
      replayed: true,
    });
    await expect(
      registerRecordingReceipt({
        ...fixture,
        receipt: { ...receipt, status: "unknown", references: [] },
      }),
    ).rejects.toMatchObject({
      code: "recording.idempotency_conflict",
      details: { runId: "run-1" },
    });
    expect(await readFile(journalPath)).toEqual(journalBefore);
  });

  it("leaves report, run journal, and verdict bytes and hashes unchanged", async () => {
    const fixture = await receiptFixture();
    const reportJsonPath = join(fixture.directory, "report.json");
    const paths = [
      reportJsonPath,
      join(fixture.directory, "report.md"),
      join(fixture.projectRoot, ".ai-qa/runs/run-1/events.jsonl"),
    ];
    const before = new Map(
      await Promise.all(
        paths.map(async (path) => {
          const bytes = await readFile(path);
          return [path, { bytes, hash: hashBytes(bytes) }] as const;
        }),
      ),
    );
    const verdictBefore = JSON.stringify(
      (
        JSON.parse((await readFile(reportJsonPath)).toString()) as {
          verdict: unknown;
        }
      ).verdict,
    );
    const verdictHashBefore = hashBytes(Buffer.from(verdictBefore));

    await registerRecordingReceipt({
      ...fixture,
      receipt: {
        status: "recorded",
        references: ["docs/qa-results.md#run-1"],
      },
    });

    for (const path of paths) {
      const current = await readFile(path);
      expect(current).toEqual(before.get(path)?.bytes);
      expect(hashBytes(current)).toBe(before.get(path)?.hash);
    }
    const verdictAfter = JSON.stringify(
      (
        JSON.parse((await readFile(reportJsonPath)).toString()) as {
          verdict: unknown;
        }
      ).verdict,
    );
    expect(verdictAfter).toBe(verdictBefore);
    expect(hashBytes(Buffer.from(verdictAfter))).toBe(verdictHashBefore);
  });

  it("returns recording integrity errors without changing the QA verdict", async () => {
    const fixture = await receiptFixture();
    await registerRecordingReceipt({
      ...fixture,
      receipt: {
        status: "recorded",
        references: ["row:42"],
      },
    });
    const eventsPath = join(
      fixture.projectRoot,
      ".ai-qa/runs/run-1/events.jsonl",
    );
    const eventsBefore = await readFile(eventsPath);
    const reportPath = join(fixture.directory, "report.json");
    const verdictBefore = (
      JSON.parse(await readFile(reportPath, "utf8")) as { verdict: unknown }
    ).verdict;
    const artifactPath = join(fixture.directory, "recording.json");
    const artifact = JSON.parse(
      await readFile(artifactPath, "utf8"),
    ) as RecordingArtifact;
    const first = artifact.history[0];
    if (first === undefined) throw new Error("Expected recording history");
    await writeFile(
      artifactPath,
      `${JSON.stringify(
        {
          ...artifact,
          history: [{ ...first, status: "unknown" }],
        },
        null,
        2,
      )}\n`,
    );

    await expect(readRecordingStatus(fixture)).rejects.toMatchObject({
      code: "recording.integrity_error",
    });
    expect(await readFile(eventsPath)).toEqual(eventsBefore);
    expect(
      (JSON.parse(await readFile(reportPath, "utf8")) as { verdict: unknown })
        .verdict,
    ).toEqual(verdictBefore);
  });

  it("uses the project-skill snapshot after current config switches to local-only", async () => {
    const fixture = await receiptFixture({ mode: "project-skill" });
    await writeProjectConfig(
      fixture.projectRoot,
      projectConfig(["web"], "local-only"),
    );

    await expect(readRecordingStatus(fixture)).resolves.toMatchObject({
      status: "pending",
    });
    const registered = await registerRecordingReceipt({
      ...fixture,
      receipt: {
        status: "recorded",
        references: ["message:abc"],
      },
    });
    await expect(readRecordingStatus(fixture)).resolves.toEqual(
      registered.status,
    );
  });

  it("uses local-only and legacy snapshots after current config switches to project-skill", async () => {
    for (const legacy of [false, true]) {
      const fixture = await receiptFixture({ mode: "local-only", legacy });
      await writeProjectConfig(
        fixture.projectRoot,
        projectConfig(["web"], "project-skill"),
      );

      await expect(readRecordingStatus(fixture)).resolves.toEqual({
        subject: RUN_SUBJECT,
        status: "not_applicable",
        references: [],
      });
      await expect(
        registerRecordingReceipt({
          ...fixture,
          receipt: {
            status: "unknown",
            references: [],
          },
        }),
      ).rejects.toMatchObject({ code: "recording.not_applicable" });
      await expectNoRecordingFiles(fixture);
    }
  });
});

describe("report recording receipt CLI", () => {
  it("prints the exact recording-status and receipt response shapes using inherited context", async () => {
    const fixture = await receiptFixture();
    let stdinReads = 0;
    const captured = createCapturedCli({
      cwd: "/outside-project",
      homeDir: "/unused-home",
      now: RECEIPT_NOW,
      readStdin: () => {
        stdinReads += 1;
        return Promise.resolve(
          JSON.stringify({
            status: "recorded",
            references: ["docs/qa-results.md#run-1"],
          }),
        );
      },
    });

    expect(
      await runCli(
        [
          "--project",
          fixture.projectRoot,
          "report",
          "recording-status",
          "run-1",
        ],
        captured.context,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.pop()!)).toEqual({
      subject: RUN_SUBJECT,
      status: "pending",
      references: [],
    });
    expect(stdinReads).toBe(0);

    expect(
      await runCli(
        [
          "report",
          "receipt",
          "run-1",
          "--stdin-json",
          "--project",
          fixture.projectRoot,
        ],
        captured.context,
      ),
    ).toBe(0);
    const receiptOutput = JSON.parse(captured.stdout.pop()!) as {
      eventId: string;
      status: string;
      references: string[];
      replayed: boolean;
    };
    expect(receiptOutput).toEqual({
      eventId: receiptOutput.eventId,
      status: "recorded",
      references: ["docs/qa-results.md#run-1"],
      replayed: false,
    });
    expect(receiptOutput.eventId).toMatch(/^recording-/u);
    expect(stdinReads).toBe(1);

    expect(
      await runCli(
        [
          "report",
          "recording-status",
          "run-1",
          "--project",
          fixture.projectRoot,
        ],
        captured.context,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.pop()!)).toEqual({
      subject: RUN_SUBJECT,
      status: "recorded",
      references: ["docs/qa-results.md#run-1"],
      eventId: receiptOutput.eventId,
      recordedAt: FIRST_RECORDED_AT,
    });
    expect(stdinReads).toBe(1);
    expect(captured.stderr).toEqual([]);
  });

  it("preserves report.not_generated from recording-status before report generation", async () => {
    const fixture = await receiptFixture({ generated: false });
    const captured = createCapturedCli({
      cwd: fixture.projectRoot,
      now: RECEIPT_NOW,
    });

    expect(
      await runCli(["report", "recording-status", "run-1"], captured.context),
    ).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: { code: "report.not_generated" },
    });
    expect(captured.stdout).toEqual([]);
  });
});
