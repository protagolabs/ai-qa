import { mkdir, open, readFile, rm } from "node:fs/promises";
import { sha256Canonical } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { RunJournal } from "./journal.js";
import { resolveRunPaths } from "./paths.js";
import {
  deepFreezeWorkOrder,
  workOrderSchema,
  type RunEvent,
  type WorkOrder,
} from "./schema.js";

function startedWorkOrderHash(events: RunEvent[], runId: string): string {
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
  ): Promise<{ journal: RunJournal; workOrderHash: string }> {
    const validated = workOrderSchema.parse(workOrder);
    const paths = resolveRunPaths(this.projectRoot, validated.runId);
    await mkdir(paths.runsRoot, { recursive: true });
    try {
      await mkdir(paths.directory, { mode: 0o700 });
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) {
        throw new AiQaError("run.already_exists", "Run already exists", {
          runId: validated.runId,
        });
      }
      throw error;
    }

    try {
      const handle = await open(paths.workOrder, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(validated), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      const workOrderHash = sha256Canonical(validated);
      const journal = await RunJournal.create(
        this.projectRoot,
        validated.runId,
        this.now,
      );
      await journal.append({
        type: "run",
        actor: "ai-qa",
        platform: "web",
        tool: "ai-qa",
        idempotencyKey: `start-${validated.runId}`,
        payload: { phase: "started", workOrderHash },
        relatedIds: [],
      });
      return { journal, workOrderHash };
    } catch (error: unknown) {
      try {
        await rm(paths.directory, { recursive: true, force: true });
      } catch {
        // Preserve the original creation failure.
      }
      if (isNodeError(error, "EEXIST")) {
        throw new AiQaError("run.already_exists", "Run already exists", {
          runId: validated.runId,
        });
      }
      throw error;
    }
  }

  async readVerifiedWorkOrder(runId: string): Promise<WorkOrder> {
    const paths = resolveRunPaths(this.projectRoot, runId);
    try {
      const raw: unknown = JSON.parse(await readFile(paths.workOrder, "utf8"));
      const workOrder = workOrderSchema.parse(raw);
      const rawHash = sha256Canonical(raw);
      const validatedHash = sha256Canonical(workOrder);
      const expectedHash = startedWorkOrderHash(
        await this.journal(runId).readAll(),
        runId,
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
      throw new AiQaError(
        "work_order.integrity_error",
        "Work order integrity verification failed",
        { runId },
      );
    }
  }

  journal(runId: string): RunJournal {
    resolveRunPaths(this.projectRoot, runId);
    return RunJournal.open(this.projectRoot, runId, this.now);
  }
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
