import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LockSignal } from "../../src/core/fs/locking.js";
import { RunJournal } from "../../src/core/runs/journal.js";
import {
  runEventSchema,
  type AppendRunEvent,
  type RunEvent,
} from "../../src/core/runs/schema.js";
import { initializeTestProject } from "../helpers/project-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const now = () => new Date("2026-07-23T00:00:00.000Z");
const uncompromised: LockSignal = { compromised: () => false };
const projectRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    projectRoots
      .splice(0)
      .map((projectRoot) => rm(projectRoot, { recursive: true, force: true })),
  );
});

async function createJournal(runId = "run-journal-append"): Promise<{
  journal: RunJournal;
  eventsPath: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-append-"));
  projectRoots.push(projectRoot);
  await initializeTestProject({ projectRoot });
  const journal = await RunJournal.create(projectRoot, runId, now);
  return {
    journal,
    eventsPath: join(projectRoot, ".ai-qa", "runs", runId, "events.jsonl"),
  };
}

function actionInput(intent: string, idempotencyKey: string): AppendRunEvent {
  return {
    type: "action",
    actor: "agent",
    platform: "web",
    tool: "chrome-devtools-mcp",
    idempotencyKey,
    payload: {
      phase: "planned",
      kind: "interaction",
      intent,
      stepId: `step-${idempotencyKey}`,
      target: { description: `${intent} target` },
    },
    relatedIds: [],
  };
}

function actionEvent(
  runId: string,
  sequence: number,
  intent: string,
): RunEvent {
  return runEventSchema.parse({
    schemaVersion: 2,
    id: `event-batch-${sequence}`,
    runId,
    sequence,
    timestamp: "2026-07-23T00:00:00.000Z",
    ...actionInput(intent, `batch-${sequence}`),
  });
}

function appendPrepared(
  journal: RunJournal,
  intent: string,
  idempotencyKey: string,
): Promise<RunEvent> {
  const input = actionInput(intent, idempotencyKey);
  return journal.appendPrepared(() =>
    Promise.resolve({ input, resolve: (event) => event }),
  );
}

describe("RunJournal append mechanics", () => {
  it("appends a single event without rewriting the file", async () => {
    const { journal, eventsPath } = await createJournal();

    await appendPrepared(journal, "First action", "single-1");
    const first = await stat(eventsPath);
    await appendPrepared(journal, "Second action", "single-2");
    const second = await stat(eventsPath);
    await appendPrepared(journal, "Third action", "single-3");
    const third = await stat(eventsPath);

    expect(second.ino).toBe(first.ino);
    expect(third.ino).toBe(first.ino);
    expect(second.size).toBeGreaterThan(first.size);
    expect(third.size).toBeGreaterThan(second.size);
  });

  it("classifies the five byte-level tail states", async () => {
    const runId = "run-tail-states";
    const { journal, eventsPath } = await createJournal(runId);
    const prefixEvent = actionEvent(runId, 1, "測 prefix action");
    const prefix = Buffer.from(`${JSON.stringify(prefixEvent)}\n`, "utf8");
    const secondEvent = actionEvent(runId, 2, "Second action");

    await writeFile(eventsPath, prefix);
    await expect(journal.readAll()).resolves.toEqual([prefixEvent]);

    const completeJsonTail = Buffer.from(JSON.stringify(secondEvent), "utf8");
    await writeFile(eventsPath, Buffer.concat([prefix, completeJsonTail]));
    await expect(journal.readAll()).rejects.toMatchObject({
      code: "journal.torn_write",
      details: { runId, tailOffset: prefix.byteLength },
    });

    const truncatedUtf8Tail = Buffer.from([0xe4, 0xb8]);
    await writeFile(eventsPath, Buffer.concat([prefix, truncatedUtf8Tail]));
    await expect(journal.readAll()).rejects.toMatchObject({
      code: "journal.torn_write",
      details: { runId, tailOffset: prefix.byteLength },
    });

    await writeFile(eventsPath, Buffer.concat([prefix, Buffer.from("{]\n")]));
    await expect(journal.readAll()).rejects.toMatchObject({
      code: "journal.integrity_error",
    });

    const malformedUtf8 = Buffer.from(
      `${JSON.stringify(actionEvent(runId, 1, "測"))}\n`,
      "utf8",
    );
    const nonAsciiOffset = malformedUtf8.indexOf(Buffer.from("測", "utf8"));
    expect(nonAsciiOffset).toBeGreaterThanOrEqual(0);
    malformedUtf8[nonAsciiOffset] = 0xff;
    await writeFile(eventsPath, malformedUtf8);
    await expect(journal.readAll()).rejects.toMatchObject({
      code: "journal.integrity_error",
    });
  });

  it("uses the atomic rewrite for batches", async () => {
    const runId = "run-atomic-batch";
    const { journal, eventsPath } = await createJournal(runId);
    const prior = await appendPrepared(journal, "Prior action", "prior");
    const before = await stat(eventsPath);
    const batch = [
      actionEvent(runId, 2, "Batch action two"),
      actionEvent(runId, 3, "Batch action three"),
    ];

    await journal.appendBatch(batch, [prior], uncompromised);

    const after = await stat(eventsPath);
    expect(after.ino).not.toBe(before.ino);
    await expect(journal.readAll()).resolves.toEqual([prior, ...batch]);
  });

  it("leaves zero of a batch's events when the batch write crashes", async () => {
    const runId = "run-failed-batch";
    const { journal, eventsPath } = await createJournal(runId);
    const prior = await appendPrepared(journal, "Prior action", "prior");
    const before = await readFile(eventsPath);
    const batch = [
      actionEvent(runId, 2, "Batch action two"),
      actionEvent(runId, 3, "Batch action three"),
    ];
    const renameMock = vi.mocked(rename);
    renameMock.mockRejectedValueOnce(new Error("injected crash"));

    await expect(
      journal.appendBatch(batch, [prior], uncompromised),
    ).rejects.toThrow("injected crash");

    expect(await readFile(eventsPath)).toEqual(before);
    expect((await readdir(join(eventsPath, ".."))).filter(isTempFile)).toEqual(
      [],
    );
    await expect(journal.readAll()).resolves.toEqual([prior]);

    renameMock.mockClear();
    await journal.appendBatch(batch, [prior], uncompromised);
    await expect(journal.readAll()).resolves.toEqual([prior, ...batch]);
  });

  it("rejects direct writes instead of resurrecting a missing journal", async () => {
    const runId = "run-missing-journal";
    const { journal, eventsPath } = await createJournal(runId);
    const workOrderPath = join(eventsPath, "..", "work-order.json");
    const event = actionEvent(runId, 1, "Direct action");
    await writeFile(workOrderPath, "{}\n");
    await rm(eventsPath);

    await expect(
      journal.appendLine(event, uncompromised),
    ).rejects.toMatchObject({ code: "journal.integrity_error" });
    await expect(access(eventsPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      journal.appendBatch([event], [], uncompromised),
    ).rejects.toMatchObject({ code: "journal.integrity_error" });
    await expect(access(eventsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create a missing run directory from a direct batch", async () => {
    const runId = "run-missing-direct-batch";
    const { journal, eventsPath } = await createJournal(runId);
    const runDirectory = join(eventsPath, "..");
    const event = actionEvent(runId, 1, "Direct batch action");
    await rm(runDirectory, { recursive: true });

    await expect(
      journal.appendBatch([event], [], uncompromised),
    ).rejects.toMatchObject({ code: "run.not_found" });
    await expect(access(runDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

function isTempFile(fileName: string): boolean {
  return fileName.endsWith(".tmp");
}
