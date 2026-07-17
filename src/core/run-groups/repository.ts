import { mkdir, open, readFile, rm } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { canonicalJson, sha256Canonical } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { readJsonLines, writeJsonLines } from "../fs/json-lines.js";
import {
  ensureProjectLocalDirectory,
  requireProjectLocalRegularFile,
} from "../fs/project-storage.js";
import { createId } from "../ids.js";
import { resolveRunGroupPaths } from "./paths.js";
import {
  runGroupEventSchema,
  runGroupIdSchema,
  runGroupManifestSchema,
  type RunGroupEvent,
  type RunGroupManifest,
} from "./schema.js";

export interface RunGroupTransitionResult {
  event: RunGroupEvent;
  manifest: RunGroupManifest;
}

export class RunGroupRepository {
  constructor(
    private readonly projectRoot: string,
    private readonly now: () => Date,
  ) {}

  async create(manifestInput: RunGroupManifest): Promise<RunGroupManifest> {
    const manifest = runGroupManifestSchema.parse(manifestInput);
    const paths = resolveRunGroupPaths(this.projectRoot, manifest.id);
    await ensureProjectLocalDirectory(this.projectRoot, [
      ".ai-qa",
      "run-groups",
    ]);
    try {
      await mkdir(paths.directory, { mode: 0o700 });
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) {
        throw new AiQaError(
          "run_group.already_exists",
          "Run group already exists",
          { runGroupId: manifest.id },
        );
      }
      throw error;
    }

    try {
      await atomicWriteFile(paths.manifest, JSON.stringify(manifest));
      let handle;
      try {
        handle = await open(paths.events, "wx", 0o600);
        await handle.sync();
      } finally {
        await handle?.close();
      }
      const started = runGroupEventSchema.parse({
        schemaVersion: 1,
        id: createId("event"),
        runGroupId: manifest.id,
        sequence: 1,
        timestamp: this.now().toISOString(),
        actor: "ai-qa",
        tool: "ai-qa",
        idempotencyKey: `start:${manifest.id}`,
        payload: { phase: "started", manifestHash: sha256Canonical(manifest) },
        relatedIds: manifest.members.map((member) => member.runId),
      });
      await writeJsonLines(paths.events, [started]);
      return freezeManifest(manifest);
    } catch (error: unknown) {
      try {
        await rm(paths.directory, { recursive: true, force: true });
      } catch {
        // Preserve the group creation failure.
      }
      throw error;
    }
  }

  async readManifest(runGroupIdInput: string): Promise<RunGroupManifest> {
    return (await this.readVerifiedSnapshot(runGroupIdInput)).manifest;
  }

  async readEvents(runGroupIdInput: string): Promise<RunGroupEvent[]> {
    return (await this.readVerifiedSnapshot(runGroupIdInput)).events;
  }

  async transition(
    runGroupIdInput: string,
    phase: "completed" | "cancelled",
    options: {
      reason?: string;
      beforeAppend: (manifest: RunGroupManifest) => Promise<void>;
    },
  ): Promise<RunGroupTransitionResult> {
    const runGroupId = runGroupIdSchema.parse(runGroupIdInput);
    const paths = resolveRunGroupPaths(this.projectRoot, runGroupId);
    await requireProjectLocalRegularFile(this.projectRoot, [
      ".ai-qa",
      "run-groups",
      runGroupId,
      "events.jsonl",
    ]);
    const release = await lockfile.lock(paths.events, {
      realpath: false,
      retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
    });
    try {
      const snapshot = await this.readVerifiedSnapshot(runGroupId);
      const terminal = snapshot.events.at(-1);
      if (terminal?.payload.phase === phase) {
        if (
          phase === "cancelled" &&
          terminal.payload.phase === "cancelled" &&
          terminal.payload.reason !== options.reason?.trim()
        ) {
          throw new AiQaError(
            "run_group.idempotency_conflict",
            "Run group was already cancelled with a different reason",
            { runGroupId },
          );
        }
        return { event: terminal, manifest: snapshot.manifest };
      }
      if (
        terminal?.payload.phase === "completed" ||
        terminal?.payload.phase === "cancelled"
      ) {
        throw new AiQaError(
          "run_group.terminal",
          "Completed or cancelled run groups cannot change lifecycle state",
          { runGroupId },
        );
      }
      const reason = options.reason?.trim();
      if (
        phase === "cancelled" &&
        (reason === undefined || reason.length === 0)
      ) {
        throw new AiQaError(
          "run_group.cancel_reason_required",
          "Run-group cancel reason is required",
        );
      }
      await options.beforeAppend(snapshot.manifest);
      const event = runGroupEventSchema.parse({
        schemaVersion: 1,
        id: createId("event"),
        runGroupId,
        sequence: snapshot.events.length + 1,
        timestamp: this.now().toISOString(),
        actor: "ai-qa",
        tool: "ai-qa",
        idempotencyKey: `${phase}:${runGroupId}`,
        payload:
          phase === "completed"
            ? { phase }
            : { phase, reason: reason as string },
        relatedIds: snapshot.manifest.members.map((member) => member.runId),
      });
      await writeJsonLines(paths.events, [...snapshot.events, event]);
      return { event, manifest: snapshot.manifest };
    } finally {
      await release();
    }
  }

  private async readVerifiedSnapshot(runGroupIdInput: string): Promise<{
    manifest: RunGroupManifest;
    events: RunGroupEvent[];
  }> {
    const runGroupId = runGroupIdSchema.parse(runGroupIdInput);
    try {
      const manifestPath = await requireProjectLocalRegularFile(
        this.projectRoot,
        [".ai-qa", "run-groups", runGroupId, "group.json"],
      );
      const eventsPath = await requireProjectLocalRegularFile(
        this.projectRoot,
        [".ai-qa", "run-groups", runGroupId, "events.jsonl"],
      );
      const rawManifest: unknown = JSON.parse(
        await readFile(manifestPath, "utf8"),
      );
      const manifest = runGroupManifestSchema.parse(rawManifest);
      const events = await readJsonLines(eventsPath, runGroupEventSchema);
      validateSnapshot(runGroupId, rawManifest, manifest, events);
      return { manifest: freezeManifest(manifest), events };
    } catch (error: unknown) {
      if (isMissingStoragePath(error)) {
        throw new AiQaError("run_group.not_found", "Run group does not exist", {
          runGroupId,
        });
      }
      if (
        error instanceof AiQaError &&
        (error.code === "run_group.not_found" ||
          error.code === "storage.integrity_error")
      ) {
        throw error;
      }
      throw new AiQaError(
        "run_group.integrity_error",
        "Run-group storage integrity verification failed",
        { runGroupId },
      );
    }
  }
}

function validateSnapshot(
  runGroupId: string,
  rawManifest: unknown,
  manifest: RunGroupManifest,
  events: RunGroupEvent[],
): void {
  if (
    manifest.id !== runGroupId ||
    canonicalJson(rawManifest) !== canonicalJson(manifest) ||
    events.length === 0
  ) {
    throw new Error("run-group identity mismatch");
  }
  for (const [index, event] of events.entries()) {
    if (event.runGroupId !== runGroupId || event.sequence !== index + 1) {
      throw new Error("run-group event sequence mismatch");
    }
    if (index === 0) {
      if (
        event.payload.phase !== "started" ||
        event.idempotencyKey !== `start:${runGroupId}` ||
        event.payload.manifestHash !== sha256Canonical(rawManifest) ||
        canonicalJson(event.relatedIds) !==
          canonicalJson(manifest.members.map((member) => member.runId))
      ) {
        throw new Error("run-group start anchor mismatch");
      }
      continue;
    }
    if (
      index !== events.length - 1 ||
      event.payload.phase === "started" ||
      event.idempotencyKey !== `${event.payload.phase}:${runGroupId}` ||
      canonicalJson(event.relatedIds) !==
        canonicalJson(manifest.members.map((member) => member.runId))
    ) {
      throw new Error("run-group lifecycle mismatch");
    }
  }
}

function freezeManifest(manifest: RunGroupManifest): RunGroupManifest {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
      return;
    }
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(manifest);
  return manifest;
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
