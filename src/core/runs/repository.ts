import { lstat, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { EVENT_SCHEMA_VERSION } from "../../schemas/versions.js";
import { sha256Canonical } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { serializeJsonLines } from "../fs/json-lines.js";
import { assertNotCompromised, withLock } from "../fs/locking.js";
import {
  ensureProjectLocalDirectory,
  requireProjectLocalRegularFile,
} from "../fs/project-storage.js";
import { createId } from "../ids.js";
import { RunJournal } from "./journal.js";
import { resolveRunPaths } from "./paths.js";
import {
  deepFreezeWorkOrder,
  runEventSchema,
  workOrderSchema,
  type RunEvent,
  type WorkOrder,
} from "./schema.js";

function startedWorkOrderHash(
  events: RunEvent[],
  runId: string,
  platform: WorkOrder["platform"],
): string {
  const startEvents = events.filter(
    (event) =>
      event.type === "run" &&
      isRecord(event.payload) &&
      event.payload.phase === "started",
  );
  if (startEvents.length !== 1) throw new Error("invalid start anchor count");
  const [event] = startEvents;
  if (event === undefined || !isRecord(event.payload)) {
    throw new Error("missing start anchor");
  }
  const payloadKeys = Object.keys(event.payload).sort();
  if (
    event.sequence !== 1 ||
    event.runId !== runId ||
    event.platform !== platform ||
    event.actor !== "ai-qa" ||
    event.tool !== "ai-qa" ||
    event.idempotencyKey !== `start-${runId}` ||
    event.relatedIds.length !== 0 ||
    payloadKeys.length !== 2 ||
    payloadKeys[0] !== "phase" ||
    payloadKeys[1] !== "workOrderHash" ||
    typeof event.payload.workOrderHash !== "string"
  ) {
    throw new Error("invalid start anchor");
  }
  return event.payload.workOrderHash;
}

export class RunRepository {
  constructor(
    private readonly projectRoot: string,
    private readonly now: () => Date,
  ) {}

  async create(
    workOrder: WorkOrder,
    options: { preCommit?: () => void } = {},
  ): Promise<{ journal: RunJournal; workOrderHash: string }> {
    const validated = workOrderSchema.parse(workOrder);
    resolveRunPaths(this.projectRoot, validated.runId);
    const runsRoot = await ensureProjectLocalDirectory(this.projectRoot, [
      ".ai-qa",
      "runs",
    ]);
    const finalDirectory = resolve(runsRoot, validated.runId);
    if (await pathExists(finalDirectory)) {
      throw runAlreadyExists(validated.runId);
    }
    const stagingDirectory = await mkdtemp(
      resolve(runsRoot, `.run-staging-${validated.runId}-`),
    );
    try {
      await ensureProjectLocalDirectory(this.projectRoot, [
        ".ai-qa",
        "runs",
        basename(stagingDirectory),
      ]);
      const workOrderHash = sha256Canonical(validated);
      const started = runEventSchema.parse({
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: createId("event"),
        runId: validated.runId,
        sequence: 1,
        timestamp: this.now().toISOString(),
        type: "run",
        actor: "ai-qa",
        platform: validated.platform,
        tool: "ai-qa",
        idempotencyKey: `start-${validated.runId}`,
        payload: { phase: "started", workOrderHash },
        relatedIds: [],
      });
      await writeSyncedFile(
        resolve(stagingDirectory, "work-order.json"),
        JSON.stringify(validated),
      );
      await writeSyncedFile(
        resolve(stagingDirectory, "events.jsonl"),
        serializeJsonLines([started]),
      );
      await syncDirectoryWhereSupported(stagingDirectory);
      const journal = RunJournal.open(
        this.projectRoot,
        validated.runId,
        this.now,
      );
      await withLock(runsRoot, "cold", async (signal) => {
        if (await pathExists(finalDirectory)) {
          throw runAlreadyExists(validated.runId);
        }
        try {
          options.preCommit?.();
          assertNotCompromised(signal, runsRoot);
          await rename(stagingDirectory, finalDirectory);
        } catch (error: unknown) {
          if (await pathExists(finalDirectory)) {
            throw runAlreadyExists(validated.runId);
          }
          throw error;
        }
      });
      return { journal, workOrderHash };
    } catch (error: unknown) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
      } catch {
        // Preserve the original staging or publication failure.
      }
      throw error;
    }
  }

  async readVerifiedWorkOrder(runId: string): Promise<WorkOrder> {
    resolveRunPaths(this.projectRoot, runId);
    let serialized: string;
    try {
      const workOrderPath = await requireProjectLocalRegularFile(
        this.projectRoot,
        [".ai-qa", "runs", runId, "work-order.json"],
      );
      serialized = await readFile(workOrderPath, "utf8");
    } catch (error: unknown) {
      if (isMissingStoragePath(error)) {
        throw new AiQaError("run.not_found", "Run does not exist", { runId });
      }
      throw workOrderIntegrityError(runId);
    }

    try {
      const raw: unknown = JSON.parse(serialized);
      const workOrder = workOrderSchema.parse(raw);
      const rawHash = sha256Canonical(raw);
      const validatedHash = sha256Canonical(workOrder);
      const expectedHash = startedWorkOrderHash(
        await this.journal(runId).readAll(),
        runId,
        workOrder.platform,
      );
      if (
        workOrder.runId !== runId ||
        rawHash !== validatedHash ||
        expectedHash !== rawHash
      ) {
        throw new Error("work order hash mismatch");
      }
      return deepFreezeWorkOrder(workOrder) as WorkOrder;
    } catch {
      throw workOrderIntegrityError(runId);
    }
  }

  journal(runId: string): RunJournal {
    resolveRunPaths(this.projectRoot, runId);
    return RunJournal.open(this.projectRoot, runId, this.now);
  }
}

async function writeSyncedFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function runAlreadyExists(runId: string): AiQaError {
  return new AiQaError("run.already_exists", "Run already exists", { runId });
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

function workOrderIntegrityError(runId: string): AiQaError {
  return new AiQaError(
    "work_order.integrity_error",
    "Work order integrity verification failed",
    { runId },
  );
}

function isMissingStoragePath(error: unknown): boolean {
  return (
    isNodeError(error, "ENOENT") ||
    (error instanceof AiQaError &&
      error.code === "storage.integrity_error" &&
      error.details.causeCode === "ENOENT")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
