import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { EVENT_SCHEMA_VERSION } from "../../schemas/versions.js";
import { canonicalJson } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { readJsonLines } from "../fs/json-lines.js";
import { createId } from "../ids.js";
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

export class RunJournal {
  private constructor(
    private readonly path: string,
    private readonly runId: string,
    private readonly now: () => Date,
  ) {}

  static async create(
    projectRoot: string,
    runId: string,
    now: () => Date,
  ): Promise<RunJournal> {
    const directory = join(projectRoot, ".ai-qa", "runs", runId);
    const path = join(directory, "events.jsonl");
    await mkdir(directory, { recursive: true });
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    return new RunJournal(path, runId, now);
  }

  static open(projectRoot: string, runId: string, now: () => Date): RunJournal {
    return new RunJournal(
      join(projectRoot, ".ai-qa", "runs", runId, "events.jsonl"),
      runId,
      now,
    );
  }

  async readAll(): Promise<RunEvent[]> {
    return readJsonLines(this.path, runEventSchema);
  }

  async append(input: AppendRunEvent): Promise<RunEvent> {
    const release = await lockfile.lock(this.path, {
      realpath: false,
      retries: { retries: 3, minTimeout: 50 },
    });
    try {
      const events = await this.readAll();
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
        timestamp: this.now().toISOString(),
        ...input,
      });
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return event;
    } finally {
      await release();
    }
  }
}
