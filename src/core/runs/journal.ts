import { open } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { EVENT_SCHEMA_VERSION } from "../../schemas/versions.js";
import { canonicalJson } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { readJsonLines } from "../fs/json-lines.js";
import {
  ensureProjectLocalDirectory,
  requireProjectLocalRegularFile,
} from "../fs/project-storage.js";
import { createId } from "../ids.js";
import { resolveRunPaths } from "./paths.js";
import {
  runEventSchema,
  type AppendRunEvent,
  type RunEvent,
} from "./schema.js";

function appendInput(event: RunEvent): AppendRunEvent {
  return {
    actor: event.actor,
    platform: event.platform,
    tool: event.tool,
    type: event.type,
    ...(event.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: event.idempotencyKey }),
    payload: event.payload,
    relatedIds: event.relatedIds,
  };
}

export interface PreparedRunAppend<T> {
  input: AppendRunEvent;
  validateTimestamp?: (timestamp: string) => void;
  resolve: (event: RunEvent) => T;
}

export class RunJournal {
  private constructor(
    private readonly projectRoot: string,
    private readonly path: string,
    private readonly runId: string,
    private readonly now: () => Date,
  ) {}

  static async create(
    projectRoot: string,
    runId: string,
    now: () => Date,
  ): Promise<RunJournal> {
    const paths = resolveRunPaths(projectRoot, runId);
    await ensureProjectLocalDirectory(projectRoot, [".ai-qa", "runs", runId]);
    let handle;
    try {
      handle = await open(paths.events, "wx", 0o600);
      await handle.sync();
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) {
        throw new AiQaError(
          "run_journal.already_exists",
          "Run journal already exists",
          { runId },
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }
    return new RunJournal(projectRoot, paths.events, runId, now);
  }

  static open(projectRoot: string, runId: string, now: () => Date): RunJournal {
    const paths = resolveRunPaths(projectRoot, runId);
    return new RunJournal(projectRoot, paths.events, runId, now);
  }

  async readAll(): Promise<RunEvent[]> {
    await requireProjectLocalRegularFile(this.projectRoot, [
      ".ai-qa",
      "runs",
      this.runId,
      "events.jsonl",
    ]);
    try {
      const events = await readJsonLines(this.path, runEventSchema);
      for (const [index, event] of events.entries()) {
        if (event.runId !== this.runId || event.sequence !== index + 1) {
          throw new Error("journal invariant mismatch");
        }
      }
      return events;
    } catch {
      throw new AiQaError(
        "journal.integrity_error",
        "Run journal integrity verification failed",
        { runId: this.runId },
      );
    }
  }

  async append(input: AppendRunEvent): Promise<RunEvent> {
    return this.appendPrepared(() =>
      Promise.resolve({ input, resolve: (event) => event }),
    );
  }

  async readLocked<T>(
    inspect: (events: readonly RunEvent[]) => T | Promise<T>,
  ): Promise<T> {
    await requireProjectLocalRegularFile(this.projectRoot, [
      ".ai-qa",
      "runs",
      this.runId,
      "events.jsonl",
    ]);
    const release = await lockfile.lock(this.path, {
      realpath: false,
      retries: { retries: 3, minTimeout: 50 },
    });
    try {
      return await inspect(await this.readAll());
    } finally {
      await release();
    }
  }

  async appendPrepared<T>(
    prepare: (events: readonly RunEvent[]) => Promise<PreparedRunAppend<T>>,
  ): Promise<T> {
    await requireProjectLocalRegularFile(this.projectRoot, [
      ".ai-qa",
      "runs",
      this.runId,
      "events.jsonl",
    ]);
    const release = await lockfile.lock(this.path, {
      realpath: false,
      retries: { retries: 3, minTimeout: 50 },
    });
    try {
      const events = await this.readAll();
      const prepared = await prepare(events);
      const timestamp = this.now().toISOString();
      prepared.validateTimestamp?.(timestamp);
      const event = await this.appendToSnapshot(
        events,
        prepared.input,
        timestamp,
      );
      return prepared.resolve(event);
    } finally {
      await release();
    }
  }

  private async appendToSnapshot(
    events: RunEvent[],
    input: AppendRunEvent,
    timestamp: string,
  ): Promise<RunEvent> {
    if (input.idempotencyKey !== undefined) {
      const existing = events.find(
        (event) => event.idempotencyKey === input.idempotencyKey,
      );
      if (existing !== undefined) {
        if (canonicalJson(appendInput(existing)) === canonicalJson(input)) {
          return existing;
        }
        throw new AiQaError(
          "event.idempotency_conflict",
          "Idempotency key was already used for a different event",
          { idempotencyKey: input.idempotencyKey },
        );
      }
    }

    const event = runEventSchema.parse({
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: createId("event"),
      runId: this.runId,
      sequence: (events.at(-1)?.sequence ?? 0) + 1,
      timestamp,
      ...input,
    });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    events.push(event);
    return event;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
