import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EVENT_SCHEMA_VERSION } from "../../schemas/versions.js";
import { canonicalJson } from "../canonical-json.js";
import { AiQaError, normalizeUnknownError, toErrorCause } from "../errors.js";
import { writeJsonLines } from "../fs/json-lines.js";
import {
  assertNotCompromised,
  withLock,
  type LockSignal,
} from "../fs/locking.js";
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
  } as AppendRunEvent;
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
    let content: Buffer;
    try {
      content = await readFile(this.path);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        typeof (error as NodeJS.ErrnoException).code === "string" &&
        (error as NodeJS.ErrnoException).code !== undefined
      ) {
        throw normalizeUnknownError(error);
      }
      throw new AiQaError(
        "journal.integrity_error",
        "Run journal integrity verification failed",
        { runId: this.runId, cause: toErrorCause(error) },
      );
    }
    try {
      const classified = classifyJournalTail(content);
      if (classified.kind === "torn") {
        throw new AiQaError(
          "journal.torn_write",
          'Run journal has an unacknowledged torn tail; run "ai-qa run repair <run-id>"',
          { runId: this.runId, tailOffset: classified.tailOffset },
        );
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        classified.complete,
      );
      const events =
        decoded.length === 0
          ? []
          : decoded
              .slice(0, -1)
              .split("\n")
              .map((line) => runEventSchema.parse(JSON.parse(line)));
      const platform = events[0]?.platform;
      for (const [index, event] of events.entries()) {
        if (
          event.runId !== this.runId ||
          event.sequence !== index + 1 ||
          event.platform !== platform
        ) {
          throw new Error("journal invariant mismatch");
        }
      }
      return events;
    } catch (error: unknown) {
      if (error instanceof AiQaError) throw error;
      throw new AiQaError(
        "journal.integrity_error",
        "Run journal integrity verification failed",
        { runId: this.runId, cause: toErrorCause(error) },
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
    try {
      await requireProjectLocalRegularFile(this.projectRoot, [
        ".ai-qa",
        "runs",
        this.runId,
        "events.jsonl",
      ]);
      return await withLock(this.path, "hot", async () =>
        inspect(await this.readAll()),
      );
    } catch (error: unknown) {
      if (isMissingStoragePath(error)) await this.throwMissingRunOrJournal();
      throw error;
    }
  }

  async appendPrepared<T>(
    prepare: (
      events: readonly RunEvent[],
      preCommit: () => void,
    ) => Promise<PreparedRunAppend<T>>,
  ): Promise<T> {
    try {
      await requireProjectLocalRegularFile(this.projectRoot, [
        ".ai-qa",
        "runs",
        this.runId,
        "events.jsonl",
      ]);
      return await withLock(this.path, "hot", async (signal) => {
        const events = await this.readAll();
        const preCommit = () => assertNotCompromised(signal, this.path);
        const prepared = await prepare(events, preCommit);
        const timestamp = this.now().toISOString();
        prepared.validateTimestamp?.(timestamp);
        const event = await this.appendToSnapshot(
          events,
          prepared.input,
          timestamp,
          signal,
        );
        return prepared.resolve(event);
      });
    } catch (error: unknown) {
      if (isMissingStoragePath(error)) await this.throwMissingRunOrJournal();
      throw error;
    }
  }

  /**
   * Low-level commit primitive. The caller must hold this journal's lock and
   * pass its signal; the journal path is revalidated before it is opened.
   */
  async appendLine(event: RunEvent, signal: LockSignal): Promise<void> {
    await this.requireExistingJournal();
    const serialized = `${JSON.stringify(event)}\n`;
    const handle = await open(this.path, "a", 0o600);
    try {
      assertNotCompromised(signal, this.path);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Low-level commit primitive. The caller must hold this journal's lock and
   * pass its signal; the journal path is revalidated before temp-file work.
   */
  async appendBatch(
    events: readonly RunEvent[],
    priorEvents: readonly RunEvent[],
    signal: LockSignal,
  ): Promise<void> {
    await this.requireExistingJournal();
    assertNotCompromised(signal, this.path);
    await writeJsonLines(this.path, [...priorEvents, ...events], {
      preCommit: () => assertNotCompromised(signal, this.path),
    });
    await syncDirectoryWhereSupported(dirname(this.path));
  }

  private async requireExistingJournal(): Promise<void> {
    try {
      await requireProjectLocalRegularFile(this.projectRoot, [
        ".ai-qa",
        "runs",
        this.runId,
        "events.jsonl",
      ]);
    } catch (error: unknown) {
      if (isMissingStoragePath(error)) await this.throwMissingRunOrJournal();
      throw error;
    }
  }

  private async throwMissingRunOrJournal(): Promise<never> {
    try {
      await requireProjectLocalRegularFile(this.projectRoot, [
        ".ai-qa",
        "runs",
        this.runId,
        "work-order.json",
      ]);
    } catch (error: unknown) {
      if (!isMissingStoragePath(error)) throw error;
      throw new AiQaError("run.not_found", "Run does not exist", {
        runId: this.runId,
      });
    }
    throw new AiQaError(
      "journal.integrity_error",
      "Run journal integrity verification failed",
      { runId: this.runId },
    );
  }

  private async appendToSnapshot(
    events: RunEvent[],
    input: AppendRunEvent,
    timestamp: string,
    signal: LockSignal,
  ): Promise<RunEvent> {
    const immutablePlatform = events[0]?.platform;
    if (
      immutablePlatform !== undefined &&
      input.platform !== immutablePlatform
    ) {
      throw new AiQaError(
        "journal.integrity_error",
        "Run journal integrity verification failed",
        { runId: this.runId },
      );
    }
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
    await this.appendLine(event, signal);
    events.push(event);
    return event;
  }
}

function classifyJournalTail(content: Buffer):
  | { kind: "ok"; complete: Buffer }
  | {
      kind: "torn";
      complete: Buffer;
      tailOffset: number;
      tailBytes: Buffer;
    } {
  if (content.length === 0 || content.at(-1) === 0x0a) {
    return { kind: "ok", complete: content };
  }
  const tailOffset = content.lastIndexOf(0x0a) + 1;
  return {
    kind: "torn",
    complete: content.subarray(0, tailOffset),
    tailOffset,
    tailBytes: content.subarray(tailOffset),
  };
}

async function syncDirectoryWhereSupported(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return [
    "EBADF",
    "EINVAL",
    "EISDIR",
    "ENOSYS",
    "ENOTSUP",
    "EOPNOTSUPP",
    "EPERM",
  ].some((code) => isNodeError(error, code));
}

function isMissingStoragePath(error: unknown): boolean {
  return (
    isNodeError(error, "ENOENT") ||
    (error instanceof AiQaError &&
      error.code === "storage.integrity_error" &&
      error.details.causeCode === "ENOENT")
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
