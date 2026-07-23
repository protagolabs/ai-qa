import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256Canonical } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { writeJsonLines } from "../fs/json-lines.js";
import { createId } from "../ids.js";
import { isJsonValue } from "../json-value.js";
import {
  recordingArtifactSchema,
  recordingEventSchema,
  recordingReceiptInputSchema,
  reportSubjectSchema,
  type RecordingArtifact,
  type RecordingEvent,
  type RecordingReceiptInput,
  type ReportSubject,
} from "./schema.js";

interface RecordingPaths {
  journal: string;
  artifact: string;
}

interface RecordingHistoryEntry {
  eventId: string;
  recordedAt: string;
  idempotencyKey: string;
  status: RecordingEvent["status"];
  references: string[];
}

interface RecordingWriteOptions {
  preCommit?: () => void;
}

const recordingHistoryFields = [
  "eventId",
  "recordedAt",
  "idempotencyKey",
  "status",
  "references",
] as const;

function historyEntry(event: RecordingEvent): RecordingHistoryEntry {
  return {
    eventId: event.eventId,
    recordedAt: event.recordedAt,
    idempotencyKey: event.idempotencyKey,
    status: event.status,
    references: event.references,
  };
}

function receiptPayload(event: RecordingEvent): RecordingReceiptInput {
  return {
    status: event.status,
    references: event.references,
  };
}

function idempotencyKeyForSubject(subject: ReportSubject): string {
  return `recording:${sha256Canonical(subject)}:v2`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rawArtifactContradictsJournal(input: {
  rawArtifact: unknown;
  subject: ReportSubject;
  events: readonly RecordingEvent[];
}): boolean {
  if (!isRecord(input.rawArtifact)) return false;
  if (
    isRecord(input.rawArtifact.subject) &&
    canonicalJson(input.rawArtifact.subject) !== canonicalJson(input.subject)
  ) {
    return true;
  }
  const rawHistory = input.rawArtifact.history;
  if (!Array.isArray(rawHistory)) return false;
  if (rawHistory.length > input.events.length) return true;

  for (const [index, rawEntry] of rawHistory.entries()) {
    if (!isRecord(rawEntry)) continue;
    const event = input.events[index];
    if (event === undefined) return true;
    const expected = historyEntry(event);
    for (const field of recordingHistoryFields) {
      if (!Object.hasOwn(rawEntry, field)) continue;
      const rawValue = rawEntry[field];
      if (
        !isJsonValue(rawValue) ||
        canonicalJson(rawValue) !== canonicalJson(expected[field])
      ) {
        return true;
      }
    }
  }
  return false;
}

export function materializeRecordingArtifact(input: {
  subject: ReportSubject;
  events: readonly RecordingEvent[];
}): RecordingArtifact {
  const subject = reportSubjectSchema.parse(input.subject);
  if (input.events.length === 0) {
    throw new TypeError(
      "Recording materialization requires at least one event",
    );
  }
  const events = input.events.map((event) => recordingEventSchema.parse(event));
  if (
    events.some(
      (event) => canonicalJson(event.subject) !== canonicalJson(subject),
    )
  ) {
    throw new TypeError("Recording event subject identity mismatch");
  }
  const current = events.at(-1);
  if (current === undefined) {
    throw new TypeError("Recording materialization requires a current event");
  }
  return recordingArtifactSchema.parse({
    schemaVersion: 2,
    subject,
    current: {
      eventId: current.eventId,
      status: current.status,
      references: current.references,
    },
    history: events.map(historyEntry),
    materializedAt: current.recordedAt,
  });
}

export function classifyRecordingMaterialization(input: {
  events: readonly RecordingEvent[];
  artifact: RecordingArtifact;
}): "current" | "recoverable" | "conflict" {
  const expected = materializeRecordingArtifact({
    subject: input.events[0]?.subject ?? input.artifact.subject,
    events: input.events,
  });
  if (
    canonicalJson(input.artifact.subject) !== canonicalJson(expected.subject)
  ) {
    return "conflict";
  }
  if (canonicalJson(input.artifact) === canonicalJson(expected)) {
    return "current";
  }
  if (input.artifact.history.length > expected.history.length) {
    return "conflict";
  }
  for (const [index, entry] of input.artifact.history.entries()) {
    if (canonicalJson(entry) !== canonicalJson(expected.history[index])) {
      return "conflict";
    }
  }
  return "recoverable";
}

export class RecordingRepository {
  private readonly directory: string;
  private readonly subject: ReportSubject;
  private readonly now: () => Date;
  private readonly paths: RecordingPaths;

  constructor(directory: string, subject: ReportSubject, now: () => Date) {
    this.directory = resolve(directory);
    this.subject = reportSubjectSchema.parse(subject);
    this.now = now;
    this.paths = {
      journal: resolve(this.directory, "recording.jsonl"),
      artifact: resolve(this.directory, "recording.json"),
    };
  }

  async readOrRecoverUnlocked(options: RecordingWriteOptions = {}): Promise<
    | { state: "missing" }
    | {
        state: "present";
        events: RecordingEvent[];
        artifact: RecordingArtifact;
      }
  > {
    const journalContent = await this.readOptionalRegularFile(
      this.paths.journal,
    );
    const artifactContent = await this.readOptionalRegularFile(
      this.paths.artifact,
    );
    if (journalContent === undefined) {
      if (artifactContent === undefined) return { state: "missing" };
      throw this.integrityError();
    }

    const events = this.parseJournal(journalContent);
    const expected = materializeRecordingArtifact({
      subject: this.subject,
      events,
    });
    if (artifactContent === undefined) {
      await this.writeArtifact(expected, options);
      return { state: "present", events, artifact: expected };
    }

    let rawArtifact: unknown;
    try {
      rawArtifact = JSON.parse(artifactContent);
    } catch {
      await this.writeArtifact(expected, options);
      return { state: "present", events, artifact: expected };
    }
    if (
      rawArtifactContradictsJournal({
        rawArtifact,
        subject: this.subject,
        events,
      })
    ) {
      throw this.integrityError();
    }
    const parsedArtifact = recordingArtifactSchema.safeParse(rawArtifact);
    if (!parsedArtifact.success) {
      await this.writeArtifact(expected, options);
      return { state: "present", events, artifact: expected };
    }
    const artifact = parsedArtifact.data;
    if (canonicalJson(artifact.subject) !== canonicalJson(this.subject)) {
      throw this.integrityError();
    }

    const classification = classifyRecordingMaterialization({
      events,
      artifact,
    });
    if (classification === "conflict") throw this.integrityError();
    if (classification === "recoverable") {
      await this.writeArtifact(expected, options);
      return { state: "present", events, artifact: expected };
    }
    return { state: "present", events, artifact };
  }

  async registerUnlocked(
    receipt: RecordingReceiptInput,
    options: RecordingWriteOptions = {},
  ): Promise<{
    event: RecordingEvent;
    artifact: RecordingArtifact;
    replayed: boolean;
  }> {
    receipt = recordingReceiptInputSchema.parse(receipt);
    const existingState = await this.readOrRecoverUnlocked(options);
    const events =
      existingState.state === "missing" ? [] : existingState.events;
    const existing = events.find(
      (event) =>
        canonicalJson(receiptPayload(event)) === canonicalJson(receipt),
    );
    if (existing !== undefined) {
      if (existingState.state === "missing") {
        throw this.integrityError();
      }
      return {
        event: existing,
        artifact: existingState.artifact,
        replayed: true,
      };
    }
    if (events.length !== 0) {
      throw new AiQaError(
        "recording.idempotency_conflict",
        "Recording receipt was already registered with a different payload",
        subjectDetails(this.subject),
      );
    }

    const event = recordingEventSchema.parse({
      schemaVersion: 2,
      eventId: createId("recording"),
      subject: this.subject,
      recordedAt: this.now().toISOString(),
      idempotencyKey: idempotencyKeyForSubject(this.subject),
      ...receipt,
    });
    const nextEvents = [...events, event];
    const artifact = materializeRecordingArtifact({
      subject: this.subject,
      events: nextEvents,
    });
    await writeJsonLines(this.paths.journal, nextEvents, options);
    await this.writeArtifact(artifact, options);
    return { event, artifact, replayed: false };
  }

  private parseJournal(content: string): RecordingEvent[] {
    try {
      if (content.length === 0 || !content.endsWith("\n")) {
        throw new Error("Recording journal must be non-empty and terminated");
      }
      const events = content
        .slice(0, -1)
        .split("\n")
        .map((line) => recordingEventSchema.parse(JSON.parse(line)));
      const eventIds = new Set<string>();
      const idempotencyKeys = new Set<string>();
      for (const event of events) {
        if (
          canonicalJson(event.subject) !== canonicalJson(this.subject) ||
          eventIds.has(event.eventId) ||
          idempotencyKeys.has(event.idempotencyKey)
        ) {
          throw new Error("Recording journal invariant mismatch");
        }
        eventIds.add(event.eventId);
        idempotencyKeys.add(event.idempotencyKey);
      }
      return events;
    } catch {
      throw this.integrityError();
    }
  }

  private async readOptionalRegularFile(
    path: string,
  ): Promise<string | undefined> {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw this.integrityError();
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw this.integrityError();
    }
    try {
      return await readFile(path, "utf8");
    } catch {
      throw this.integrityError();
    }
  }

  private writeArtifact(
    artifact: RecordingArtifact,
    options: RecordingWriteOptions,
  ): Promise<void> {
    return atomicWriteFile(
      this.paths.artifact,
      `${JSON.stringify(artifact, null, 2)}\n`,
      options,
    );
  }

  private integrityError(): AiQaError {
    return new AiQaError(
      "recording.integrity_error",
      "Recording journal and materialized view failed integrity verification",
      subjectDetails(this.subject),
    );
  }
}

function subjectDetails(
  subject: ReportSubject,
): { runId: string } | { runGroupId: string } {
  return subject.kind === "run"
    ? { runId: subject.id }
    : { runGroupId: subject.id };
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
