import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Canonical } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { RunJournal } from "./journal.js";
import { workOrderSchema, type RunEvent, type WorkOrder } from "./schema.js";

function startedWorkOrderHash(events: RunEvent[]): string | undefined {
  for (const event of events) {
    if (
      event.type !== "run" ||
      event.payload === null ||
      typeof event.payload !== "object"
    ) {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    if (
      payload.phase === "started" &&
      typeof payload.workOrderHash === "string"
    ) {
      return payload.workOrderHash;
    }
  }
  return undefined;
}

export class RunRepository {
  constructor(
    private readonly projectRoot: string,
    private readonly now: () => Date,
  ) {}

  async create(
    workOrder: WorkOrder,
  ): Promise<{ journal: RunJournal; workOrderHash: string }> {
    const directory = join(this.projectRoot, ".ai-qa", "runs", workOrder.runId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "work-order.json");
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(workOrder), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    const workOrderHash = sha256Canonical(workOrder);
    const journal = await RunJournal.create(
      this.projectRoot,
      workOrder.runId,
      this.now,
    );
    await journal.append({
      type: "run",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: `start-${workOrder.runId}`,
      payload: { phase: "started", workOrderHash },
      relatedIds: [],
    });
    return { journal, workOrderHash };
  }

  async readVerifiedWorkOrder(runId: string): Promise<WorkOrder> {
    const workOrder = workOrderSchema.parse(
      JSON.parse(
        await readFile(
          join(this.projectRoot, ".ai-qa", "runs", runId, "work-order.json"),
          "utf8",
        ),
      ),
    );
    const expectedHash = startedWorkOrderHash(
      await this.journal(runId).readAll(),
    );
    const actualHash = sha256Canonical(workOrder);
    if (
      workOrder.runId !== runId ||
      expectedHash === undefined ||
      expectedHash !== actualHash
    ) {
      throw new AiQaError(
        "work_order.integrity_error",
        "Work order does not match the run start event",
        { runId },
      );
    }
    return workOrder;
  }

  journal(runId: string): RunJournal {
    return RunJournal.open(this.projectRoot, runId, this.now);
  }
}
