import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { controllerForPlatform } from "../../core/platforms/registry.js";
import { AiQaError, toErrorCause } from "../../core/errors.js";
import {
  evidenceRecordSchema,
  normalizedRelativePosixPathSchema,
  type EvidenceRecord,
} from "../../core/evidence/schema.js";
import { atomicWriteFile } from "../../core/fs/atomic-write.js";
import { serializeJsonLines } from "../../core/fs/json-lines.js";
import {
  assertNotCompromised,
  withLock,
  type LockSignal,
} from "../../core/fs/locking.js";
import {
  ensureProjectLocalDirectory,
  inspectOptionalProjectLocalRegularFile,
  prepareProjectLocalRemoval,
  publishProjectLocalRegularFile,
  requireProjectLocalRegularFile,
  type PreparedProjectLocalRemoval,
} from "../../core/fs/project-storage.js";
import { resolveRunPaths } from "../../core/runs/paths.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  runEventSchema,
  runIdSchema,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import { resolveProject } from "../project-root/resolve-project.js";

const repairRelocationSchema = z
  .object({
    kind: z.enum(["evidence-file", "evidence-index-entry", "journal-tail"]),
    evidenceId: z.string().optional(),
    sourcePath: normalizedRelativePosixPathSchema,
    recoveryPath: normalizedRelativePosixPathSchema,
    contentHash: z.string(),
  })
  .strict()
  .superRefine((relocation, context) => {
    const evidenceRelocation =
      relocation.kind === "evidence-file" ||
      relocation.kind === "evidence-index-entry";
    const sourcePrefix = evidenceRelocation
      ? ".ai-qa/evidence/"
      : ".ai-qa/runs/";
    if (!relocation.sourcePath.startsWith(sourcePrefix)) {
      context.addIssue({
        code: "custom",
        path: ["sourcePath"],
        message: `Repair source path must start with "${sourcePrefix}"`,
      });
    }
    if (!relocation.recoveryPath.startsWith(".ai-qa/recovery/")) {
      context.addIssue({
        code: "custom",
        path: ["recoveryPath"],
        message: 'Repair recovery path must start with ".ai-qa/recovery/"',
      });
    }
    if (evidenceRelocation && relocation.evidenceId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["evidenceId"],
        message: "Evidence relocations require an evidence ID",
      });
    }
    if (
      relocation.kind === "journal-tail" &&
      relocation.evidenceId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceId"],
        message: "Journal-tail relocations cannot name an evidence ID",
      });
    }
  });

const repairManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: runIdSchema,
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    relocations: z.array(repairRelocationSchema),
    journalTail: z
      .object({
        truncateOffset: z.number().int().nonnegative(),
        byteLength: z.number().int().positive(),
        contentHash: z.string(),
      })
      .strict()
      .optional(),
    orphanedEvidenceIds: z.array(z.string()),
  })
  .strict()
  .superRefine((manifest, context) => {
    const evidenceRoot = `.ai-qa/evidence/${manifest.runId}/`;
    const recoveryRoot = `.ai-qa/recovery/${manifest.runId}/`;
    const journalPath = `.ai-qa/runs/${manifest.runId}/events.jsonl`;
    const indexPath = `${evidenceRoot}index.jsonl`;
    const orphaned = new Set(manifest.orphanedEvidenceIds);
    if (orphaned.size !== manifest.orphanedEvidenceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["orphanedEvidenceIds"],
        message: "Orphaned evidence IDs must be unique",
      });
    }

    let journalRelocations = 0;
    const recoveryPaths = new Set<string>();
    const evidenceRelocations = new Map<
      string,
      Set<"evidence-file" | "evidence-index-entry">
    >();
    for (const [index, relocation] of manifest.relocations.entries()) {
      if (!relocation.recoveryPath.startsWith(recoveryRoot)) {
        context.addIssue({
          code: "custom",
          path: ["relocations", index, "recoveryPath"],
          message: "Repair recovery path must stay inside this run",
        });
      }
      if (relocation.recoveryPath === `${recoveryRoot}repair-manifest.json`) {
        context.addIssue({
          code: "custom",
          path: ["relocations", index, "recoveryPath"],
          message: "Repair relocation cannot overwrite its manifest",
        });
      }
      if (recoveryPaths.has(relocation.recoveryPath)) {
        context.addIssue({
          code: "custom",
          path: ["relocations", index, "recoveryPath"],
          message: "Repair recovery paths must be unique",
        });
      }
      recoveryPaths.add(relocation.recoveryPath);
      if (relocation.kind === "journal-tail") {
        journalRelocations += 1;
        if (relocation.sourcePath !== journalPath) {
          context.addIssue({
            code: "custom",
            path: ["relocations", index, "sourcePath"],
            message: "Journal-tail source must be this run journal",
          });
        }
        continue;
      }

      const evidenceId = relocation.evidenceId;
      if (evidenceId === undefined) continue;
      if (!orphaned.has(evidenceId)) {
        context.addIssue({
          code: "custom",
          path: ["relocations", index, "evidenceId"],
          message: "Evidence relocation must name an orphan in this manifest",
        });
      }
      if (
        relocation.kind === "evidence-file" &&
        !relocation.sourcePath.startsWith(`${evidenceRoot}files/${evidenceId}-`)
      ) {
        context.addIssue({
          code: "custom",
          path: ["relocations", index, "sourcePath"],
          message: "Evidence-file source must stay inside this run",
        });
      }
      if (
        relocation.kind === "evidence-index-entry" &&
        relocation.sourcePath !== indexPath
      ) {
        context.addIssue({
          code: "custom",
          path: ["relocations", index, "sourcePath"],
          message: "Evidence-index source must be this run index",
        });
      }
      const kinds = evidenceRelocations.get(evidenceId) ?? new Set();
      if (kinds.has(relocation.kind)) {
        context.addIssue({
          code: "custom",
          path: ["relocations", index],
          message: "Evidence relocation kinds must be unique per orphan",
        });
      }
      kinds.add(relocation.kind);
      evidenceRelocations.set(evidenceId, kinds);
    }

    for (const evidenceId of orphaned) {
      const kinds = evidenceRelocations.get(evidenceId);
      if (
        kinds?.has("evidence-file") !== true ||
        kinds.has("evidence-index-entry") !== true
      ) {
        context.addIssue({
          code: "custom",
          path: ["relocations"],
          message: `Orphan ${evidenceId} requires file and index relocations`,
        });
      }
    }
    if (
      (manifest.journalTail === undefined && journalRelocations !== 0) ||
      (manifest.journalTail !== undefined && journalRelocations !== 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["journalTail"],
        message:
          "Journal-tail metadata and relocation must be present together",
      });
    }
    const journalRelocation = manifest.relocations.find(
      (relocation) => relocation.kind === "journal-tail",
    );
    if (
      journalRelocation !== undefined &&
      manifest.journalTail !== undefined &&
      journalRelocation.contentHash !== manifest.journalTail.contentHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["journalTail", "contentHash"],
        message: "Journal-tail hashes must match",
      });
    }
  });

type RepairManifest = z.infer<typeof repairManifestSchema>;
type RepairRelocation = z.infer<typeof repairRelocationSchema>;

export interface RepairReport {
  readonly runId: string;
  readonly relocated: readonly {
    kind: "evidence-file" | "evidence-index-entry" | "journal-tail";
    reference: string;
    recoveryPath: string;
  }[];
}

interface RepairContext {
  projectRoot: string;
  runId: string;
  journalPath: string;
  evidenceIndexPath: string;
  journalSignal: LockSignal;
  evidenceSignal: LockSignal;
  now: () => Date;
  hooks: RepairRunHooks;
}

interface RepairRunHooks {
  afterRecoveryPublishFinalVerification?: (input: {
    recoveryPath: string;
  }) => Promise<void>;
  afterEvidenceDeleteFinalVerification?: (input: {
    sourcePath: string;
  }) => Promise<void>;
  afterDurablePublish?: (input: {
    step:
      | "repair-manifest-planned"
      | "evidence-file"
      | "evidence-index-entry"
      | "journal-tail"
      | "evidence-index"
      | "repair-manifest-completed";
  }) => void | Promise<void>;
  beforeDestructiveCommit?: (input: {
    step: "journal-truncate" | "evidence-delete";
  }) => void | Promise<void>;
}

export interface RepairRunOptions {
  readonly hooks?: RepairRunHooks;
}

interface ClassifiedJournal {
  complete: Buffer;
  tailOffset?: number;
  tailBytes?: Buffer;
}

export async function requireNoIncompleteRepair(
  projectRoot: string,
  runId: string,
): Promise<void> {
  runId = runIdSchema.parse(runId);
  const manifest = await loadManifest(projectRoot, runId);
  if (manifest !== undefined && manifest.completedAt === undefined) {
    throw new AiQaError(
      "run.repair_incomplete",
      'An interrupted repair exists; run "ai-qa run repair <run-id>"',
      { runId },
    );
  }
}

export async function repairRun(
  input: {
    projectRoot: string;
    runId: string;
    now: () => Date;
  },
  options: RepairRunOptions = {},
): Promise<RepairReport> {
  const runId = runIdSchema.parse(input.runId);
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const projectRoot = project.projectRoot;
  const runPaths = resolveRunPaths(projectRoot, runId);
  const evidenceIndexSegments = [
    ".ai-qa",
    "evidence",
    runId,
    "index.jsonl",
  ] as const;
  const evidenceIndexPath = resolve(projectRoot, ...evidenceIndexSegments);
  const previewManifest = await loadManifest(projectRoot, runId);
  if (
    previewManifest !== undefined &&
    previewManifest.completedAt === undefined
  ) {
    await preflightManifestPaths(projectRoot, runId, previewManifest);
  }
  await requireProjectLocalRegularFile(projectRoot, [
    ".ai-qa",
    "runs",
    runId,
    "events.jsonl",
  ]);

  return withLock(runPaths.events, "hot", async (journalSignal) => {
    const currentManifest = await loadManifest(projectRoot, runId);
    const journal = await readVerifiedJournal(
      projectRoot,
      runId,
      runPaths.events,
      input.now,
    );
    const index = await inspectOptionalProjectLocalRegularFile(
      projectRoot,
      evidenceIndexSegments,
    );
    const needsRepairCriticalSection =
      (currentManifest !== undefined &&
        currentManifest.completedAt === undefined) ||
      index.state === "regular" ||
      journal.classified.tailBytes !== undefined;
    if (!needsRepairCriticalSection) {
      return emptyReport(runId);
    }

    if (
      currentManifest !== undefined &&
      currentManifest.completedAt === undefined
    ) {
      await preflightManifestState(
        projectRoot,
        runId,
        input.now,
        currentManifest,
      );
    }
    assertNotCompromised(journalSignal, runPaths.events);
    await ensureProjectLocalDirectory(projectRoot, [
      ".ai-qa",
      "evidence",
      runId,
    ]);
    return withLock(evidenceIndexPath, "cold", async (evidenceSignal) => {
      const context: RepairContext = {
        projectRoot,
        runId,
        journalPath: runPaths.events,
        evidenceIndexPath,
        journalSignal,
        evidenceSignal,
        now: input.now,
        hooks: options.hooks ?? {},
      };
      const reloaded = await loadManifest(projectRoot, runId);
      const manifest =
        reloaded !== undefined && reloaded.completedAt === undefined
          ? reloaded
          : await computeManifest(context);
      if (manifest === undefined) return emptyReport(runId);
      const preparedRemovals = await preflightManifestState(
        context.projectRoot,
        context.runId,
        context.now,
        manifest,
        context,
      );
      await executeManifest(context, manifest, preparedRemovals);
      return reportFromManifest(manifest);
    });
  });
}

async function computeManifest(
  context: RepairContext,
): Promise<RepairManifest | undefined> {
  const journal = await readVerifiedJournal(
    context.projectRoot,
    context.runId,
    context.journalPath,
    context.now,
  );
  const records = await readEvidenceIndex(
    context.projectRoot,
    context.runId,
    journal.workOrder,
  );
  const journalEvidenceIds = new Set(
    journal.events.flatMap((event) =>
      event.type === "evidence" ? [event.payload.id] : [],
    ),
  );
  const orphaned = records.filter(
    (record) => !journalEvidenceIds.has(record.id),
  );
  const relocations: RepairRelocation[] = [];
  for (const record of orphaned) {
    const sourcePath = record.projectRelativePath;
    const source = await requireProjectLocalRegularFile(
      context.projectRoot,
      pathSegments(sourcePath),
    );
    const fileBytes = await readFile(source);
    const fileHash = sha256(fileBytes);
    if (fileHash !== record.contentHash) {
      throw new AiQaError(
        "evidence.integrity_error",
        "Orphaned evidence content hash verification failed",
        {
          runId: context.runId,
          evidenceId: record.id,
          expectedHash: record.contentHash,
          actualHash: fileHash,
        },
      );
    }
    const indexBytes = Buffer.from(`${JSON.stringify(record)}\n`);
    relocations.push(
      {
        kind: "evidence-file",
        evidenceId: record.id,
        sourcePath,
        recoveryPath: `.ai-qa/recovery/${context.runId}/evidence/files/${basename(
          sourcePath,
        )}`,
        contentHash: fileHash,
      },
      {
        kind: "evidence-index-entry",
        evidenceId: record.id,
        sourcePath: `.ai-qa/evidence/${context.runId}/index.jsonl`,
        recoveryPath: `.ai-qa/recovery/${context.runId}/evidence/index/${record.id}.jsonl`,
        contentHash: sha256(indexBytes),
      },
    );
  }

  const journalTail =
    journal.classified.tailBytes === undefined ||
    journal.classified.tailOffset === undefined
      ? undefined
      : {
          truncateOffset: journal.classified.tailOffset,
          byteLength: journal.classified.tailBytes.byteLength,
          contentHash: sha256(journal.classified.tailBytes),
        };
  if (journalTail !== undefined) {
    const hashSuffix = journalTail.contentHash.slice("sha256:".length, 18);
    relocations.push({
      kind: "journal-tail",
      sourcePath: `.ai-qa/runs/${context.runId}/events.jsonl`,
      recoveryPath: `.ai-qa/recovery/${context.runId}/journal/events.jsonl.${journalTail.truncateOffset}.${hashSuffix}.tail`,
      contentHash: journalTail.contentHash,
    });
  }
  if (relocations.length === 0) return undefined;

  const manifest = repairManifestSchema.parse({
    schemaVersion: 1,
    runId: context.runId,
    createdAt: context.now().toISOString(),
    relocations,
    ...(journalTail === undefined ? {} : { journalTail }),
    orphanedEvidenceIds: orphaned.map((record) => record.id),
  });
  await ensureRecoveryDirectory(context);
  await writeManifest(context, manifest);
  return manifest;
}

async function executeManifest(
  context: RepairContext,
  manifest: RepairManifest,
  preparedRemovals: ReadonlyMap<string, PreparedProjectLocalRemoval>,
): Promise<void> {
  await ensureRecoveryDirectory(context);
  for (const relocation of manifest.relocations) {
    await copyRelocation(context, manifest, relocation);
  }
  await rewriteEvidenceIndex(context, manifest);
  await truncateJournal(context, manifest);
  await deleteEvidenceSources(context, manifest, preparedRemovals);
  const completed = repairManifestSchema.parse({
    ...manifest,
    completedAt: context.now().toISOString(),
  });
  await requireProjectLocalRegularFile(context.projectRoot, [
    ".ai-qa",
    "recovery",
    context.runId,
    "repair-manifest.json",
  ]);
  await writeManifest(context, completed);
}

async function preflightManifestPaths(
  projectRoot: string,
  runId: string,
  manifest: RepairManifest,
): Promise<void> {
  for (const relocation of manifest.relocations) {
    const destination = await inspectOptionalProjectLocalRegularFile(
      projectRoot,
      pathSegments(relocation.recoveryPath),
    );
    if (relocation.kind === "evidence-file") {
      const source = await inspectOptionalProjectLocalRegularFile(
        projectRoot,
        pathSegments(relocation.sourcePath),
      );
      if (source.state === "missing" && destination.state === "missing") {
        throw repairIntegrityError(
          runId,
          "Repair source and recovery copy are both missing",
          relocation,
        );
      }
      if (source.state === "regular") {
        const sourcePath = await requireProjectLocalRegularFile(
          projectRoot,
          pathSegments(relocation.sourcePath),
        );
        const actualHash = sha256(await readFile(sourcePath));
        if (actualHash !== relocation.contentHash) {
          throw repairIntegrityError(
            runId,
            "Repair deletion source content does not match its manifest",
            relocation,
            { actualHash },
          );
        }
      }
    } else {
      await requireProjectLocalRegularFile(
        projectRoot,
        pathSegments(relocation.sourcePath),
      );
    }
    const bytes =
      destination.state === "regular"
        ? await readFile(
            await requireProjectLocalRegularFile(
              projectRoot,
              pathSegments(relocation.recoveryPath),
            ),
          )
        : await relocationBytes(projectRoot, runId, manifest, relocation);
    const actualHash = sha256(bytes);
    if (actualHash !== relocation.contentHash) {
      throw repairIntegrityError(
        runId,
        "Repair relocation content does not match its manifest",
        relocation,
        { actualHash },
      );
    }
  }
}

async function preflightManifestState(
  projectRoot: string,
  runId: string,
  now: () => Date,
  manifest: RepairManifest,
  context?: RepairContext,
): Promise<ReadonlyMap<string, PreparedProjectLocalRemoval>> {
  await preflightManifestPaths(projectRoot, runId, manifest);
  const journal = await readVerifiedJournal(
    projectRoot,
    runId,
    resolveRunPaths(projectRoot, runId).events,
    now,
  );
  const records = await readEvidenceIndex(
    projectRoot,
    runId,
    journal.workOrder,
  );
  const journalEvidenceIds = new Set(
    journal.events.flatMap((event) =>
      event.type === "evidence" ? [event.payload.id] : [],
    ),
  );
  const plannedOrphans = new Set(manifest.orphanedEvidenceIds);
  for (const record of records) {
    if (!journalEvidenceIds.has(record.id) && !plannedOrphans.has(record.id)) {
      throw repairIntegrityError(
        runId,
        "Evidence index contains an orphan outside the repair manifest",
      );
    }
  }
  for (const evidenceId of plannedOrphans) {
    if (journalEvidenceIds.has(evidenceId)) {
      throw repairIntegrityError(
        runId,
        "Repair manifest classifies journaled evidence as orphaned",
        undefined,
        { evidenceId },
      );
    }
    await requireEvidencePlanBinding(
      projectRoot,
      runId,
      manifest,
      records,
      journal.workOrder,
      evidenceId,
    );
  }
  await requireJournalTailBinding(projectRoot, runId, manifest, journal);
  const preparedRemovals = new Map<string, PreparedProjectLocalRemoval>();
  for (const relocation of manifest.relocations) {
    if (relocation.kind !== "evidence-file") continue;
    preparedRemovals.set(
      relocation.sourcePath,
      await prepareProjectLocalRemoval({
        projectRoot,
        segments: pathSegments(relocation.sourcePath),
        expected: "file",
        ...(context === undefined
          ? {}
          : {
              hooks: {
                afterFinalVerification: async () => {
                  await context.hooks.afterEvidenceDeleteFinalVerification?.({
                    sourcePath: relocation.sourcePath,
                  });
                },
                beforeClaim: async () => {
                  await context.hooks.beforeDestructiveCommit?.({
                    step: "evidence-delete",
                  });
                  assertBothLocks(context);
                },
              },
            }),
      }),
    );
  }
  return preparedRemovals;
}

async function requireEvidencePlanBinding(
  projectRoot: string,
  runId: string,
  manifest: RepairManifest,
  currentRecords: readonly EvidenceRecord[],
  workOrder: WorkOrder,
  evidenceId: string,
): Promise<void> {
  const fileRelocation = manifest.relocations.find(
    (relocation) =>
      relocation.kind === "evidence-file" &&
      relocation.evidenceId === evidenceId,
  );
  const indexRelocation = manifest.relocations.find(
    (relocation) =>
      relocation.kind === "evidence-index-entry" &&
      relocation.evidenceId === evidenceId,
  );
  if (fileRelocation === undefined || indexRelocation === undefined) {
    throw repairIntegrityError(
      runId,
      "Repair manifest is missing an orphan relocation",
      undefined,
      { evidenceId },
    );
  }
  const currentRecord = currentRecords.find(
    (record) => record.id === evidenceId,
  );
  const record =
    currentRecord ??
    (await readRecoveredEvidenceRecord(projectRoot, runId, indexRelocation));
  const expectedController = controllerForPlatform(workOrder.platform);
  const indexBytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (
    record.id !== evidenceId ||
    record.runId !== runId ||
    record.platform !== workOrder.platform ||
    record.sourceTool !== expectedController ||
    record.projectRelativePath !== fileRelocation.sourcePath ||
    record.contentHash !== fileRelocation.contentHash ||
    sha256(indexBytes) !== indexRelocation.contentHash
  ) {
    throw repairIntegrityError(
      runId,
      "Repair evidence relocations do not match their index record",
      undefined,
      { evidenceId },
    );
  }
}

async function readRecoveredEvidenceRecord(
  projectRoot: string,
  runId: string,
  relocation: RepairRelocation,
): Promise<EvidenceRecord> {
  const records = await readEvidenceIndexAtPath(
    projectRoot,
    runId,
    relocation.recoveryPath,
  );
  const record = records[0];
  if (records.length !== 1 || record === undefined) {
    throw repairIntegrityError(
      runId,
      "Recovered evidence index relocation is not one complete record",
      relocation,
    );
  }
  return record;
}

async function requireJournalTailBinding(
  projectRoot: string,
  runId: string,
  manifest: RepairManifest,
  journal: {
    classified: ClassifiedJournal;
    events: RunEvent[];
    workOrder: WorkOrder;
  },
): Promise<void> {
  const plannedTail = manifest.journalTail;
  if (plannedTail === undefined) {
    if (journal.classified.tailBytes !== undefined) {
      throw repairIntegrityError(
        runId,
        "Repair manifest omits the current torn journal tail",
      );
    }
    return;
  }
  const relocation = manifest.relocations.find(
    (candidate) => candidate.kind === "journal-tail",
  );
  if (relocation === undefined) {
    throw repairIntegrityError(
      runId,
      "Repair manifest is missing its journal-tail relocation",
    );
  }
  const currentTail = journal.classified.tailBytes;
  if (currentTail !== undefined) {
    if (
      journal.classified.tailOffset !== plannedTail.truncateOffset ||
      currentTail.byteLength !== plannedTail.byteLength ||
      sha256(currentTail) !== plannedTail.contentHash
    ) {
      throw repairIntegrityError(
        runId,
        "Current torn journal tail does not match the repair manifest",
        relocation,
      );
    }
    return;
  }
  if (journal.classified.complete.byteLength !== plannedTail.truncateOffset) {
    throw repairIntegrityError(
      runId,
      "Healthy journal bytes cannot satisfy a torn-tail repair plan",
      relocation,
      { byteLength: journal.classified.complete.byteLength },
    );
  }
  const recovered = await requireProjectLocalRegularFile(
    projectRoot,
    pathSegments(relocation.recoveryPath),
  );
  const recoveredBytes = await readFile(recovered);
  if (
    recoveredBytes.byteLength !== plannedTail.byteLength ||
    sha256(recoveredBytes) !== plannedTail.contentHash
  ) {
    throw repairIntegrityError(
      runId,
      "Truncated journal is not backed by its verified recovery copy",
      relocation,
    );
  }
}

async function ensureRecoveryDirectory(
  context: RepairContext,
): Promise<string> {
  assertBothLocks(context);
  return ensureProjectLocalDirectory(context.projectRoot, [
    ".ai-qa",
    "recovery",
    context.runId,
  ]);
}

async function writeManifest(
  context: RepairContext,
  manifest: RepairManifest,
): Promise<void> {
  const path = resolve(
    context.projectRoot,
    ".ai-qa",
    "recovery",
    context.runId,
    "repair-manifest.json",
  );
  await atomicWriteFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    preCommit: () => assertBothLocks(context),
    durable: true,
  });
  await context.hooks.afterDurablePublish?.({
    step:
      manifest.completedAt === undefined
        ? "repair-manifest-planned"
        : "repair-manifest-completed",
  });
}

async function copyRelocation(
  context: RepairContext,
  manifest: RepairManifest,
  relocation: RepairRelocation,
): Promise<void> {
  const existing = await inspectOptionalProjectLocalRegularFile(
    context.projectRoot,
    pathSegments(relocation.recoveryPath),
  );
  if (existing.state === "regular") {
    const destination = await requireProjectLocalRegularFile(
      context.projectRoot,
      pathSegments(relocation.recoveryPath),
    );
    const actualHash = sha256(await readFile(destination));
    if (actualHash !== relocation.contentHash) {
      throw repairIntegrityError(
        context.runId,
        "Recovery copy content hash does not match its manifest",
        relocation,
        { actualHash },
      );
    }
    return;
  }

  const bytes = await relocationBytes(
    context.projectRoot,
    context.runId,
    manifest,
    relocation,
  );
  const actualHash = sha256(bytes);
  if (actualHash !== relocation.contentHash) {
    throw repairIntegrityError(
      context.runId,
      "Repair source content hash does not match its manifest",
      relocation,
      { actualHash },
    );
  }
  await publishProjectLocalRegularFile({
    projectRoot: context.projectRoot,
    segments: pathSegments(relocation.recoveryPath),
    content: bytes,
    preCommit: () => assertBothLocks(context),
    durable: true,
    hooks: {
      afterFinalVerification: async () => {
        await context.hooks.afterRecoveryPublishFinalVerification?.({
          recoveryPath: relocation.recoveryPath,
        });
      },
    },
  });
  await context.hooks.afterDurablePublish?.({ step: relocation.kind });
}

async function relocationBytes(
  projectRoot: string,
  runId: string,
  manifest: RepairManifest,
  relocation: RepairRelocation,
): Promise<Buffer> {
  switch (relocation.kind) {
    case "evidence-file": {
      const source = await requireProjectLocalRegularFile(
        projectRoot,
        pathSegments(relocation.sourcePath),
      );
      return readFile(source);
    }
    case "evidence-index-entry": {
      const evidenceId = relocation.evidenceId;
      if (evidenceId === undefined) {
        throw repairIntegrityError(
          runId,
          "Evidence-index relocation has no evidence ID",
          relocation,
        );
      }
      const records = await readEvidenceIndexAtPath(
        projectRoot,
        runId,
        relocation.sourcePath,
      );
      const record = records.find((candidate) => candidate.id === evidenceId);
      if (record === undefined) {
        throw repairIntegrityError(
          runId,
          "Orphaned evidence index entry is unavailable for recovery",
          relocation,
        );
      }
      return Buffer.from(`${JSON.stringify(record)}\n`);
    }
    case "journal-tail": {
      const tail = manifest.journalTail;
      if (tail === undefined) {
        throw repairIntegrityError(
          runId,
          "Journal-tail relocation has no truncation metadata",
          relocation,
        );
      }
      const source = await requireProjectLocalRegularFile(
        projectRoot,
        pathSegments(relocation.sourcePath),
      );
      const content = await readFile(source);
      if (content.byteLength !== tail.truncateOffset + tail.byteLength) {
        throw repairIntegrityError(
          runId,
          "Run journal length does not match the repair manifest",
          relocation,
          { byteLength: content.byteLength },
        );
      }
      return content.subarray(
        tail.truncateOffset,
        tail.truncateOffset + tail.byteLength,
      );
    }
  }
}

async function rewriteEvidenceIndex(
  context: RepairContext,
  manifest: RepairManifest,
): Promise<void> {
  if (manifest.orphanedEvidenceIds.length === 0) return;
  const records = await readEvidenceIndexAtPath(
    context.projectRoot,
    context.runId,
    `.ai-qa/evidence/${context.runId}/index.jsonl`,
  );
  const orphaned = new Set(manifest.orphanedEvidenceIds);
  if (!records.some((record) => orphaned.has(record.id))) return;
  const retained = records.filter((record) => !orphaned.has(record.id));
  await requireProjectLocalRegularFile(context.projectRoot, [
    ".ai-qa",
    "evidence",
    context.runId,
    "index.jsonl",
  ]);
  await atomicWriteFile(
    context.evidenceIndexPath,
    serializeJsonLines(retained),
    { preCommit: () => assertBothLocks(context), durable: true },
  );
  await context.hooks.afterDurablePublish?.({ step: "evidence-index" });
}

async function truncateJournal(
  context: RepairContext,
  manifest: RepairManifest,
): Promise<void> {
  const tail = manifest.journalTail;
  if (tail === undefined) return;
  const path = await requireProjectLocalRegularFile(context.projectRoot, [
    ".ai-qa",
    "runs",
    context.runId,
    "events.jsonl",
  ]);
  const current = await stat(path);
  if (current.size === tail.truncateOffset) return;
  if (current.size !== tail.truncateOffset + tail.byteLength) {
    throw repairIntegrityError(
      context.runId,
      "Run journal length does not match the repair manifest",
      undefined,
      { byteLength: current.size },
    );
  }
  const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(tail.byteLength);
    const { bytesRead } = await handle.read(
      bytes,
      0,
      bytes.byteLength,
      tail.truncateOffset,
    );
    if (bytesRead !== bytes.byteLength || sha256(bytes) !== tail.contentHash) {
      throw repairIntegrityError(
        context.runId,
        "Run journal tail content does not match the repair manifest",
      );
    }
    await context.hooks.beforeDestructiveCommit?.({
      step: "journal-truncate",
    });
    assertBothLocks(context);
    await handle.truncate(tail.truncateOffset);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function deleteEvidenceSources(
  context: RepairContext,
  manifest: RepairManifest,
  preparedRemovals: ReadonlyMap<string, PreparedProjectLocalRemoval>,
): Promise<void> {
  for (const relocation of manifest.relocations) {
    if (relocation.kind !== "evidence-file") continue;
    const prepared = preparedRemovals.get(relocation.sourcePath);
    if (prepared === undefined) {
      throw repairIntegrityError(
        context.runId,
        "Evidence source was not prepared for contained deletion",
        relocation,
      );
    }
    await prepared.remove();
  }
}

async function readVerifiedJournal(
  projectRoot: string,
  runId: string,
  path: string,
  now: () => Date,
): Promise<{
  classified: ClassifiedJournal;
  events: RunEvent[];
  workOrder: WorkOrder;
}> {
  await requireProjectLocalRegularFile(projectRoot, [
    ".ai-qa",
    "runs",
    runId,
    "events.jsonl",
  ]);
  const classified = classifyJournal(await readFile(path));
  let events: RunEvent[];
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      classified.complete,
    );
    events =
      decoded.length === 0
        ? []
        : decoded
            .slice(0, -1)
            .split("\n")
            .map((line) => runEventSchema.parse(JSON.parse(line)));
    const platform = events[0]?.platform;
    for (const [index, event] of events.entries()) {
      if (
        event.runId !== runId ||
        event.sequence !== index + 1 ||
        event.platform !== platform
      ) {
        throw new Error("journal invariant mismatch");
      }
    }
  } catch (error: unknown) {
    throw new AiQaError(
      "journal.integrity_error",
      "Run journal integrity verification failed",
      { runId, cause: toErrorCause(error) },
    );
  }
  const workOrder = await new RunRepository(
    projectRoot,
    now,
  ).readVerifiedWorkOrder(runId, events);
  return { classified, events, workOrder };
}

function classifyJournal(content: Buffer): ClassifiedJournal {
  if (content.length === 0 || content.at(-1) === 0x0a) {
    return { complete: content };
  }
  const tailOffset = content.lastIndexOf(0x0a) + 1;
  return {
    complete: content.subarray(0, tailOffset),
    tailOffset,
    tailBytes: content.subarray(tailOffset),
  };
}

async function readEvidenceIndex(
  projectRoot: string,
  runId: string,
  workOrder: WorkOrder,
): Promise<EvidenceRecord[]> {
  const records = await readEvidenceIndexAtPath(
    projectRoot,
    runId,
    `.ai-qa/evidence/${runId}/index.jsonl`,
    true,
  );
  const expectedController = controllerForPlatform(workOrder.platform);
  for (const record of records) {
    if (
      record.runId !== runId ||
      record.platform !== workOrder.platform ||
      record.sourceTool !== expectedController
    ) {
      throw evidenceIndexIntegrityError(runId);
    }
  }
  return records;
}

async function readEvidenceIndexAtPath(
  projectRoot: string,
  runId: string,
  sourcePath: string,
  optional = false,
): Promise<EvidenceRecord[]> {
  const inspected = await inspectOptionalProjectLocalRegularFile(
    projectRoot,
    pathSegments(sourcePath),
  );
  if (inspected.state === "missing") {
    if (optional) return [];
    throw evidenceIndexIntegrityError(runId);
  }
  const content = inspected.content ?? "";
  try {
    if (content.length === 0) return [];
    if (!content.endsWith("\n")) throw new Error("unterminated index");
    const records = content
      .slice(0, -1)
      .split("\n")
      .map((line) => evidenceRecordSchema.parse(JSON.parse(line)));
    if (new Set(records.map((record) => record.id)).size !== records.length) {
      throw new Error("duplicate evidence ID");
    }
    return records;
  } catch {
    throw evidenceIndexIntegrityError(runId);
  }
}

async function loadManifest(
  projectRoot: string,
  runId: string,
): Promise<RepairManifest | undefined> {
  const inspected = await inspectOptionalProjectLocalRegularFile(projectRoot, [
    ".ai-qa",
    "recovery",
    runId,
    "repair-manifest.json",
  ]);
  if (inspected.state === "missing") return undefined;
  const raw: unknown = JSON.parse(inspected.content ?? "");
  return repairManifestSchema
    .refine((manifest) => manifest.runId === runId, {
      path: ["runId"],
      message: "Repair manifest run ID must match its storage path",
    })
    .parse(raw);
}

function reportFromManifest(manifest: RepairManifest): RepairReport {
  return {
    runId: manifest.runId,
    relocated: manifest.relocations.map((relocation) => ({
      kind: relocation.kind,
      reference:
        relocation.kind === "journal-tail"
          ? `events.jsonl@${manifest.journalTail!.truncateOffset}`
          : relocation.evidenceId!,
      recoveryPath: relocation.recoveryPath,
    })),
  };
}

function emptyReport(runId: string): RepairReport {
  return { runId, relocated: [] };
}

function pathSegments(path: string): string[] {
  return path.split("/");
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertBothLocks(context: RepairContext): void {
  assertNotCompromised(context.journalSignal, context.journalPath);
  assertNotCompromised(context.evidenceSignal, context.evidenceIndexPath);
}

function evidenceIndexIntegrityError(runId: string): AiQaError {
  return new AiQaError(
    "evidence.integrity_error",
    "Evidence index integrity verification failed",
    { runId },
  );
}

function repairIntegrityError(
  runId: string,
  message: string,
  relocation?: RepairRelocation,
  details: Readonly<Record<string, unknown>> = {},
): AiQaError {
  return new AiQaError("run.repair_integrity_error", message, {
    runId,
    ...(relocation === undefined
      ? {}
      : {
          kind: relocation.kind,
          sourcePath: relocation.sourcePath,
          recoveryPath: relocation.recoveryPath,
        }),
    ...details,
  });
}
