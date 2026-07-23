import { lstat, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { canonicalJson, sha256Canonical } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import {
  atomicWriteFile,
  syncDirectoryWhereSupported,
} from "../fs/atomic-write.js";
import {
  readJsonLines,
  serializeJsonLines,
  writeJsonLines,
} from "../fs/json-lines.js";
import { assertNotCompromised, withLock } from "../fs/locking.js";
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

export const runGroupStagingPrefix = ".group-staging-";

export class RunGroupRepository {
  constructor(
    private readonly projectRoot: string,
    private readonly now: () => Date,
  ) {}

  async create(manifestInput: RunGroupManifest): Promise<RunGroupManifest> {
    const manifest = runGroupManifestSchema.parse(manifestInput);
    const paths = resolveRunGroupPaths(this.projectRoot, manifest.id);
    const root = await ensureProjectLocalDirectory(this.projectRoot, [
      ".ai-qa",
      "run-groups",
    ]);
    if (await pathExists(paths.directory))
      throw runGroupAlreadyExists(manifest.id);
    const stagingDirectory = await mkdtemp(
      resolve(root, `${runGroupStagingPrefix}${manifest.id}-`),
    );
    try {
      await ensureProjectLocalDirectory(this.projectRoot, [
        ".ai-qa",
        "run-groups",
        basename(stagingDirectory),
      ]);
      const stagingManifest = resolve(stagingDirectory, "group.json");
      const stagingEvents = resolve(stagingDirectory, "events.jsonl");
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
      await atomicWriteFile(stagingManifest, JSON.stringify(manifest), {
        durable: true,
      });
      await atomicWriteFile(stagingEvents, serializeJsonLines([started]), {
        durable: true,
      });
      await syncDirectoryWhereSupported(stagingDirectory);
      await withLock(root, "cold", async (signal) => {
        if (await pathExists(paths.directory)) {
          throw runGroupAlreadyExists(manifest.id);
        }
        try {
          assertNotCompromised(signal, root);
          await rename(stagingDirectory, paths.directory);
        } catch (error: unknown) {
          if (await pathExists(paths.directory)) {
            throw runGroupAlreadyExists(manifest.id);
          }
          throw error;
        }
        await syncDirectoryWhereSupported(root);
      });
      return freezeManifest(manifest);
    } catch (error: unknown) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true });
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

  async readLocked<T>(
    runGroupIdInput: string,
    operation: (snapshot: {
      manifest: RunGroupManifest;
      events: RunGroupEvent[];
    }) => Promise<T>,
  ): Promise<T> {
    const runGroupId = runGroupIdSchema.parse(runGroupIdInput);
    const paths = resolveRunGroupPaths(this.projectRoot, runGroupId);
    await requireProjectLocalRegularFile(this.projectRoot, [
      ".ai-qa",
      "run-groups",
      runGroupId,
      "events.jsonl",
    ]);
    return withLock(paths.events, "cold", async () =>
      operation(await this.readVerifiedSnapshot(runGroupId)),
    );
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
    return withLock(paths.events, "cold", async (signal) => {
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
      if (
        !snapshot.events.some((event) => event.payload.phase === "materialized")
      ) {
        throw new AiQaError(
          "run_group.not_materialized",
          "Run group must be fully materialized before becoming terminal",
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
      await writeJsonLines(paths.events, [...snapshot.events, event], {
        preCommit: () => assertNotCompromised(signal, paths.events),
      });
      return { event, manifest: snapshot.manifest };
    });
  }

  async materialize(
    runGroupIdInput: string,
    beforeAppend: (
      manifest: RunGroupManifest,
      allowCreate: boolean,
      preCommit: () => void,
    ) => Promise<void>,
  ): Promise<RunGroupTransitionResult> {
    const runGroupId = runGroupIdSchema.parse(runGroupIdInput);
    const paths = resolveRunGroupPaths(this.projectRoot, runGroupId);
    await requireProjectLocalRegularFile(this.projectRoot, [
      ".ai-qa",
      "run-groups",
      runGroupId,
      "events.jsonl",
    ]);
    return withLock(paths.events, "cold", async (signal) => {
      const snapshot = await this.readVerifiedSnapshot(runGroupId);
      const latest = snapshot.events.at(-1);
      const allowCreate =
        latest?.payload.phase !== "completed" &&
        latest?.payload.phase !== "cancelled";
      const preCommit = () => assertNotCompromised(signal, paths.events);
      await beforeAppend(snapshot.manifest, allowCreate, preCommit);
      const existing = snapshot.events.find(
        (event) => event.payload.phase === "materialized",
      );
      if (existing !== undefined) {
        return { event: existing, manifest: snapshot.manifest };
      }
      if (latest?.payload.phase !== "started") {
        throw new AiQaError(
          "run_group.terminal",
          "Terminal run groups cannot be materialized",
          { runGroupId },
        );
      }
      const event = runGroupEventSchema.parse({
        schemaVersion: 1,
        id: createId("event"),
        runGroupId,
        sequence: snapshot.events.length + 1,
        timestamp: this.now().toISOString(),
        actor: "ai-qa",
        tool: "ai-qa",
        idempotencyKey: `materialized:${runGroupId}`,
        payload: { phase: "materialized" },
        relatedIds: snapshot.manifest.members.map((member) => member.runId),
      });
      await writeJsonLines(paths.events, [...snapshot.events, event], {
        preCommit,
      });
      return { event, manifest: snapshot.manifest };
    });
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function runGroupAlreadyExists(runGroupId: string): AiQaError {
  return new AiQaError("run_group.already_exists", "Run group already exists", {
    runGroupId,
  });
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
    if (
      canonicalJson(event.relatedIds) !==
      canonicalJson(manifest.members.map((member) => member.runId))
    ) {
      throw new Error("run-group member links mismatch");
    }
  }
  const started = events[0];
  if (
    started?.payload.phase !== "started" ||
    started.idempotencyKey !== `start:${runGroupId}` ||
    started.payload.manifestHash !== sha256Canonical(rawManifest)
  ) {
    throw new Error("run-group start anchor mismatch");
  }
  const materialized = events[1];
  if (
    materialized !== undefined &&
    (materialized.payload.phase !== "materialized" ||
      materialized.idempotencyKey !== `materialized:${runGroupId}`)
  ) {
    throw new Error("run-group materialization mismatch");
  }
  const terminal = events[2];
  if (
    terminal !== undefined &&
    (terminal.payload.phase === "started" ||
      terminal.payload.phase === "materialized" ||
      terminal.idempotencyKey !== `${terminal.payload.phase}:${runGroupId}`)
  ) {
    throw new Error("run-group terminal lifecycle mismatch");
  }
  if (events.length > 3) {
    throw new Error("run-group lifecycle contains extra events");
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
