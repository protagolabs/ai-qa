import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { writeJsonLines } from "../fs/json-lines.js";
import { createId } from "../ids.js";
import { runIdSchema } from "../runs/schema.js";
import {
  recordingArtifactSchema,
  recordingEventSchema,
  recordingReceiptInputSchema,
  type RecordingArtifact,
  type RecordingEvent,
  type RecordingReceiptInput,
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
    idempotencyKey: event.idempotencyKey,
    status: event.status,
    references: event.references,
  };
}

export function materializeRecordingArtifact(input: {
  runId: string;
  events: readonly RecordingEvent[];
}): RecordingArtifact {
  const runId = runIdSchema.parse(input.runId);
  if (input.events.length === 0) {
    throw new TypeError(
      "Recording materialization requires at least one event",
    );
  }
  const events = input.events.map((event) => recordingEventSchema.parse(event));
  if (events.some((event) => event.runId !== runId)) {
    throw new TypeError("Recording event run identity mismatch");
  }
  const current = events.at(-1);
  if (current === undefined) {
    throw new TypeError("Recording materialization requires a current event");
  }
  return recordingArtifactSchema.parse({
    schemaVersion: 1,
    runId,
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
    runId: input.events[0]?.runId ?? input.artifact.runId,
    events: input.events,
  });
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
  private readonly runId: string;
  private readonly now: () => Date;
  private readonly paths: RecordingPaths;

  constructor(directory: string, runId: string, now: () => Date) {
    this.directory = resolve(directory);
    this.runId = runIdSchema.parse(runId);
    this.now = now;
    this.paths = {
      journal: resolve(this.directory, "recording.jsonl"),
      artifact: resolve(this.directory, "recording.json"),
    };
  }

  async readOrRecoverUnlocked(): Promise<
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
      runId: this.runId,
      events,
    });
    if (artifactContent === undefined) {
      await this.writeArtifact(expected);
      return { state: "present", events, artifact: expected };
    }

    let artifact: RecordingArtifact;
    try {
      const value: unknown = JSON.parse(artifactContent);
      artifact = recordingArtifactSchema.parse(value);
    } catch {
      await this.writeArtifact(expected);
      return { state: "present", events, artifact: expected };
    }
    if (artifact.runId !== this.runId) throw this.integrityError();

    const classification = classifyRecordingMaterialization({
      events,
      artifact,
    });
    if (classification === "conflict") throw this.integrityError();
    if (classification === "recoverable") {
      await this.writeArtifact(expected);
      return { state: "present", events, artifact: expected };
    }
    return { state: "present", events, artifact };
  }

  async registerUnlocked(receipt: RecordingReceiptInput): Promise<{
    event: RecordingEvent;
    artifact: RecordingArtifact;
    replayed: boolean;
  }> {
    receipt = recordingReceiptInputSchema.parse(receipt);
    const existingState = await this.readOrRecoverUnlocked();
    const events =
      existingState.state === "missing" ? [] : existingState.events;
    const existing = events.find(
      (event) => event.idempotencyKey === receipt.idempotencyKey,
    );
    if (existing !== undefined) {
      if (canonicalJson(receiptPayload(existing)) !== canonicalJson(receipt)) {
        throw new AiQaError(
          "recording.idempotency_conflict",
          "Recording idempotency key was already used for a different receipt",
          { idempotencyKey: receipt.idempotencyKey },
        );
      }
      if (existingState.state === "missing") {
        throw this.integrityError();
      }
      return {
        event: existing,
        artifact: existingState.artifact,
        replayed: true,
      };
    }

    const event = recordingEventSchema.parse({
      schemaVersion: 1,
      eventId: createId("recording"),
      runId: this.runId,
      recordedAt: this.now().toISOString(),
      ...receipt,
    });
    const nextEvents = [...events, event];
    const artifact = materializeRecordingArtifact({
      runId: this.runId,
      events: nextEvents,
    });
    await writeJsonLines(this.paths.journal, nextEvents);
    await this.writeArtifact(artifact);
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
          event.runId !== this.runId ||
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

  private writeArtifact(artifact: RecordingArtifact): Promise<void> {
    return atomicWriteFile(
      this.paths.artifact,
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
  }

  private integrityError(): AiQaError {
    return new AiQaError(
      "recording.integrity_error",
      "Recording journal and materialized view failed integrity verification",
      { runId: this.runId },
    );
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
