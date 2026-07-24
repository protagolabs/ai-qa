import { EVENT_SCHEMA_VERSION } from "../../schemas/versions.js";
import { canonicalJson } from "../canonical-json.js";
import {
  AiQaError,
  errorCauseCode,
  toErrorCause,
  toFilesystemOperationFailure,
} from "../errors.js";
import {
  assertNotCompromised,
  withLock,
  type LockSignal,
} from "../fs/locking.js";
import {
  atomicReplaceProjectLocalRegularFile,
  requireProjectLocalRegularFile,
  withProjectLocalRegularFile,
} from "../fs/project-storage.js";
import { createId } from "../ids.js";
import { isEnvironmentalErrnoCode, isNodeError } from "../node-errors.js";
import { resolveRunPaths } from "./paths.js";
import {
  runEventSchema,
  type AppendRunEvent,
  type RunEvent,
} from "./schema.js";

export function appendInput(event: RunEvent): AppendRunEvent {
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

export class RunJournal {
  private constructor(
    private readonly projectRoot: string,
    private readonly path: string,
    private readonly runId: string,
    private readonly now: () => Date,
  ) {}

  static open(projectRoot: string, runId: string, now: () => Date): RunJournal {
    const paths = resolveRunPaths(projectRoot, runId);
    return new RunJournal(projectRoot, paths.events, runId, now);
  }

  async readAll(): Promise<RunEvent[]> {
    return (await this.readSnapshot()).events;
  }

  private async readSnapshot(): Promise<{
    events: RunEvent[];
    serialized: Buffer;
  }> {
    let content: Buffer;
    try {
      content = await withProjectLocalRegularFile(
        {
          projectRoot: this.projectRoot,
          segments: [".ai-qa", "runs", this.runId, "events.jsonl"],
          mode: "read",
        },
        async ({ handle, revalidate }) => {
          await revalidate();
          const before = await handle.stat({ bigint: true });
          const bytes = await handle.readFile();
          const after = await handle.stat({ bigint: true });
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs
          ) {
            throw new AiQaError(
              "storage.integrity_error",
              "Run journal changed while it was being read",
              { runId: this.runId },
            );
          }
          await revalidate();
          return bytes;
        },
      );
    } catch (error: unknown) {
      if (isFilesystemOperationFailure(error)) {
        throw toFilesystemOperationFailure(error);
      }
      throw error;
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
      return { events, serialized: classified.complete };
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
    return this.readLocked(async (events, signal) => {
      const timestamp = this.now().toISOString();
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
      return event;
    });
  }

  async readLocked<T>(
    inspect: (
      events: readonly RunEvent[],
      signal: LockSignal,
      serialized: Buffer,
    ) => T | Promise<T>,
    options: { beforeRead?: () => Promise<void> } = {},
  ): Promise<T> {
    try {
      await requireProjectLocalRegularFile(this.projectRoot, [
        ".ai-qa",
        "runs",
        this.runId,
        "events.jsonl",
      ]);
      return await withLock(this.path, "hot", async (signal) => {
        await options.beforeRead?.();
        const snapshot = await this.readSnapshot();
        return inspect(
          snapshot.events,
          signal,
          Buffer.from(snapshot.serialized),
        );
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
    try {
      assertNotCompromised(signal, this.path);
      await withProjectLocalRegularFile(
        {
          projectRoot: this.projectRoot,
          segments: [".ai-qa", "runs", this.runId, "events.jsonl"],
          mode: "append",
        },
        async ({ handle, revalidate }) => {
          await revalidate();
          assertNotCompromised(signal, this.path);
          await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
          await handle.sync();
          await revalidate();
        },
      );
    } catch (error: unknown) {
      if (isMissingStoragePath(error)) await this.throwMissingRunOrJournal();
      throw error;
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
    priorSerialized?: Buffer,
  ): Promise<void> {
    try {
      assertNotCompromised(signal, this.path);
      const historical =
        priorSerialized ??
        Buffer.from(
          priorEvents.map((event) => `${JSON.stringify(event)}\n`).join(""),
          "utf8",
        );
      const appended = Buffer.from(
        events.map((event) => `${JSON.stringify(event)}\n`).join(""),
        "utf8",
      );
      await atomicReplaceProjectLocalRegularFile({
        projectRoot: this.projectRoot,
        segments: [".ai-qa", "runs", this.runId, "events.jsonl"],
        content: Buffer.concat([historical, appended]),
        preCommit: () => assertNotCompromised(signal, this.path),
      });
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

function isMissingStoragePath(error: unknown): boolean {
  return (
    isNodeError(error, "ENOENT") ||
    (error instanceof AiQaError &&
      error.code === "storage.integrity_error" &&
      errorCauseCode(error) === "ENOENT")
  );
}

function isFilesystemOperationFailure(error: unknown): boolean {
  return isEnvironmentalErrnoCode(errorCauseCode(error));
}
