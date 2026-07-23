import { open, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { CASE_INDEX_SCHEMA_VERSION } from "../../schemas/versions.js";
import { AiQaError, errorCauseCode } from "../errors.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { assertNotCompromised, withLock } from "../fs/locking.js";
import {
  ensureProjectLocalDirectory,
  requireProjectLocalDirectory,
  requireProjectLocalRegularFile,
} from "../fs/project-storage.js";
import { isNodeError } from "../node-errors.js";
import {
  calculateCaseContentHash,
  caseIdSchema,
  caseIndexSchema,
  caseRevisionSchema,
  type CaseIndex,
  type CaseRevision,
} from "./schema.js";

const activationSchema = z
  .object({
    confirmedBy: z.literal("user"),
    confirmedAt: z.string().datetime(),
  })
  .strict();

interface CasePaths {
  directory: string;
  index: string;
  revisions: string;
}

export class CaseRepository {
  constructor(private readonly projectRoot: string) {}

  async createDraft(
    input: Omit<CaseRevision, "revision" | "contentHash">,
  ): Promise<CaseRevision> {
    const caseId = caseIdSchema.parse(input.caseId);
    const paths = this.paths(caseId);
    await ensureProjectLocalDirectory(this.projectRoot, [
      ".ai-qa",
      "cases",
      caseId,
      "revisions",
    ]);
    return this.withCaseWriteLock(
      paths,
      (preCommit) =>
        this.ensureIndex(paths.index, caseId, input.title, preCommit),
      async (preCommit) => {
        let revisionPath: string | undefined;
        let ownsRevision = false;
        try {
          const index = await this.readIndex(caseId);
          const revision =
            Math.max(0, ...index.revisions.map((entry) => entry.revision)) + 1;
          const candidate = caseRevisionSchema.parse({
            ...input,
            revision,
            contentHash: "",
          });
          const value = caseRevisionSchema.parse({
            ...candidate,
            contentHash: calculateCaseContentHash(candidate),
          });
          revisionPath = this.revisionPath(paths, revision);
          await this.writeRevisionOnce(
            revisionPath,
            value,
            () => {
              ownsRevision = true;
            },
            preCommit,
          );
          await atomicWriteFile(
            paths.index,
            stringify(
              caseIndexSchema.parse({
                ...index,
                title: value.title,
                revisions: [
                  ...index.revisions,
                  {
                    revision,
                    status: "draft",
                    contentHash: value.contentHash,
                  },
                ],
              }),
              { sortMapEntries: true },
            ),
            { preCommit },
          );
          revisionPath = undefined;
          return value;
        } catch (error: unknown) {
          if (revisionPath !== undefined && ownsRevision) {
            try {
              await rm(revisionPath);
            } catch {
              // Preserve the draft creation failure.
            }
          }
          throw error;
        }
      },
    );
  }

  async createDraftFromLatest(
    caseIdInput: string,
    initialTitle: string,
    build: (
      latest: CaseRevision | undefined,
    ) => Omit<CaseRevision, "revision" | "contentHash">,
  ): Promise<CaseRevision> {
    const caseId = caseIdSchema.parse(caseIdInput);
    const paths = this.paths(caseId);
    await ensureProjectLocalDirectory(this.projectRoot, [
      ".ai-qa",
      "cases",
      caseId,
      "revisions",
    ]);
    return this.withCaseWriteLock(
      paths,
      (preCommit) =>
        this.ensureIndex(paths.index, caseId, initialTitle, preCommit),
      async (preCommit) => {
        let revisionPath: string | undefined;
        let ownsRevision = false;
        try {
          const index = await this.readIndex(caseId);
          const latestEntry = index.revisions.reduce<
            CaseIndex["revisions"][number] | undefined
          >(
            (latest, entry) =>
              latest === undefined || entry.revision > latest.revision
                ? entry
                : latest,
            undefined,
          );
          const latest =
            latestEntry === undefined
              ? undefined
              : await this.validateRevision(caseId, latestEntry.revision);
          const input = build(latest);
          if (input.caseId !== caseId) {
            throw new AiQaError(
              "case.revision_identity_mismatch",
              "Merged case draft must retain the locked case identity",
              { caseId, proposedCaseId: input.caseId },
            );
          }
          const revision = (latestEntry?.revision ?? 0) + 1;
          const candidate = caseRevisionSchema.parse({
            ...input,
            revision,
            contentHash: "",
          });
          const value = caseRevisionSchema.parse({
            ...candidate,
            contentHash: calculateCaseContentHash(candidate),
          });
          revisionPath = this.revisionPath(paths, revision);
          await this.writeRevisionOnce(
            revisionPath,
            value,
            () => {
              ownsRevision = true;
            },
            preCommit,
          );
          await atomicWriteFile(
            paths.index,
            stringify(
              caseIndexSchema.parse({
                ...index,
                title: value.title,
                revisions: [
                  ...index.revisions,
                  {
                    revision,
                    status: "draft",
                    contentHash: value.contentHash,
                  },
                ],
              }),
              { sortMapEntries: true },
            ),
            { preCommit },
          );
          revisionPath = undefined;
          return value;
        } catch (error: unknown) {
          if (revisionPath !== undefined && ownsRevision) {
            try {
              await rm(revisionPath);
            } catch {
              // Preserve the draft creation failure.
            }
          }
          throw error;
        }
      },
    );
  }

  async readRevision(caseId: string, revision: number): Promise<CaseRevision> {
    caseId = caseIdSchema.parse(caseId);
    revision = z.number().int().positive().parse(revision);
    try {
      const revisionPath = await requireProjectLocalRegularFile(
        this.projectRoot,
        [".ai-qa", "cases", caseId, "revisions", `${String(revision)}.yaml`],
      );
      const value: unknown = parse(await readFile(revisionPath, "utf8"));
      const parsed = caseRevisionSchema.parse(value);
      if (parsed.caseId !== caseId || parsed.revision !== revision) {
        throw new Error("revision identity mismatch");
      }
      return parsed;
    } catch (error: unknown) {
      if (
        isNodeError(error, "ENOENT") ||
        (error instanceof AiQaError &&
          error.code === "storage.integrity_error" &&
          isMissingStoragePath(error))
      ) {
        throw new AiQaError(
          "case.revision_not_found",
          "Case revision does not exist",
          { caseId, revision },
        );
      }
      throw error;
    }
  }

  async validateRevision(
    caseId: string,
    revision: number,
  ): Promise<CaseRevision> {
    return (await this.validateRevisionAndIndex(caseId, revision)).revision;
  }

  private async validateRevisionAndIndex(
    caseId: string,
    revision: number,
    existingIndex?: CaseIndex,
  ): Promise<{ revision: CaseRevision; index: CaseIndex }> {
    caseId = caseIdSchema.parse(caseId);
    revision = z.number().int().positive().parse(revision);
    try {
      const value = await this.readRevision(caseId, revision);
      const actualHash = calculateCaseContentHash(value);
      if (actualHash !== value.contentHash) {
        throw new Error("content hash mismatch");
      }
      const index = existingIndex ?? (await this.readIndex(caseId));
      const indexed = index.revisions.find(
        (entry) => entry.revision === revision,
      );
      if (indexed === undefined || indexed.contentHash !== value.contentHash) {
        throw new AiQaError(
          "case.index_integrity_error",
          "Case index does not match its immutable revision",
          { caseId, revision },
        );
      }
      return { revision: value, index };
    } catch (error: unknown) {
      if (
        error instanceof AiQaError &&
        (error.code === "case.revision_not_found" ||
          error.code === "case.index_integrity_error" ||
          error.code === "storage.integrity_error")
      ) {
        throw error;
      }
      throw new AiQaError(
        "case.content_hash_mismatch",
        "Case revision content hash verification failed",
        { caseId, revision },
      );
    }
  }

  async activate(
    caseId: string,
    revision: number,
    confirmation: { confirmedBy: "user"; confirmedAt: string },
  ): Promise<CaseRevision> {
    caseId = caseIdSchema.parse(caseId);
    revision = z.number().int().positive().parse(revision);
    const confirmed = activationSchema.parse(confirmation);
    const paths = this.paths(caseId);
    await requireProjectLocalRegularFile(this.projectRoot, [
      ".ai-qa",
      "cases",
      caseId,
      "case.yaml",
    ]);
    return this.withCaseWriteLock(paths, undefined, async (preCommit) => {
      const validated = await this.validateRevisionAndIndex(caseId, revision);
      const value = validated.revision;
      const index = validated.index;
      const target = index.revisions.find(
        (entry) => entry.revision === revision,
      );
      if (target === undefined || target.contentHash !== value.contentHash) {
        throw new AiQaError(
          "case.index_integrity_error",
          "Case index does not match its immutable revision",
          { caseId, revision },
        );
      }
      if (target.status === "active" && index.activeRevision === revision) {
        return value;
      }
      if (target.status !== "draft") {
        throw new AiQaError(
          "case.revision_not_activatable",
          "Only a draft case revision can be activated",
          { caseId, revision, status: target.status },
        );
      }
      const next = caseIndexSchema.parse({
        ...index,
        activeRevision: revision,
        revisions: index.revisions.map((entry) => {
          if (entry.revision === revision) {
            return {
              ...entry,
              status: "active" as const,
              activation: confirmed,
            };
          }
          if (entry.status === "active") {
            return { ...entry, status: "superseded" as const };
          }
          return entry;
        }),
      });
      await atomicWriteFile(
        paths.index,
        stringify(next, { sortMapEntries: true }),
        { preCommit },
      );
      return value;
    });
  }

  async readActive(caseId: string): Promise<CaseRevision> {
    caseId = caseIdSchema.parse(caseId);
    const index = await this.readIndex(caseId);
    if (index.activeRevision === undefined) {
      throw new AiQaError(
        "case.active_revision_missing",
        "Case does not have an active revision",
        { caseId },
      );
    }
    const revision = (
      await this.validateRevisionAndIndex(caseId, index.activeRevision, index)
    ).revision;
    const active = index.revisions.find(
      (entry) => entry.revision === index.activeRevision,
    );
    if (
      active?.status !== "active" ||
      active.contentHash !== revision.contentHash
    ) {
      throw new AiQaError(
        "case.index_integrity_error",
        "Active case index entry does not match its immutable revision",
        { caseId, revision: index.activeRevision },
      );
    }
    return revision;
  }

  async listActive(): Promise<CaseRevision[]> {
    const casesRoot = await requireProjectLocalDirectory(this.projectRoot, [
      ".ai-qa",
      "cases",
    ]);
    const entries = await readdir(casesRoot, { withFileTypes: true });
    const caseIds = entries
      .map((entry) => entry.name)
      .filter((name) => caseIdSchema.safeParse(name).success)
      .sort();
    const active: CaseRevision[] = [];
    for (const caseId of caseIds) {
      const index = await this.readIndex(caseId);
      if (index.activeRevision !== undefined) {
        const revision = (
          await this.validateRevisionAndIndex(
            caseId,
            index.activeRevision,
            index,
          )
        ).revision;
        const entry = index.revisions.find(
          (candidate) => candidate.revision === index.activeRevision,
        );
        if (
          entry?.status !== "active" ||
          entry.contentHash !== revision.contentHash
        ) {
          throw new AiQaError(
            "case.index_integrity_error",
            "Active case index entry does not match its immutable revision",
            { caseId, revision: index.activeRevision },
          );
        }
        active.push(revision);
      }
    }
    return active;
  }

  private paths(caseId: string): CasePaths {
    const casesRoot = resolve(this.projectRoot, ".ai-qa", "cases");
    const directory = resolve(casesRoot, caseIdSchema.parse(caseId));
    return {
      directory,
      index: resolve(directory, "case.yaml"),
      revisions: resolve(directory, "revisions"),
    };
  }

  private revisionPath(paths: CasePaths, revision: number): string {
    return resolve(paths.revisions, `${String(revision)}.yaml`);
  }

  private async ensureIndex(
    path: string,
    caseId: string,
    title: string,
    preCommit: () => void,
  ): Promise<void> {
    const initial = caseIndexSchema.parse({
      schemaVersion: CASE_INDEX_SCHEMA_VERSION,
      id: caseId,
      title,
      revisions: [],
    });
    let handle;
    let ownsIndex = false;
    let failed = false;
    let failure: unknown;
    try {
      preCommit();
      handle = await open(path, "wx", 0o600);
      ownsIndex = true;
      await handle.writeFile(
        stringify(initial, { sortMapEntries: true }),
        "utf8",
      );
      await handle.sync();
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) return;
      failed = true;
      failure = error;
    } finally {
      await handle?.close();
    }
    if (failed) {
      if (ownsIndex) {
        try {
          await rm(path);
        } catch {
          // Preserve the index initialization failure.
        }
      }
      throw failure;
    }
  }

  private async withCaseWriteLock<T>(
    paths: CasePaths,
    initialize: ((preCommit: () => void) => Promise<void>) | undefined,
    operation: (preCommit: () => void) => Promise<T>,
  ): Promise<T> {
    return withLock(paths.directory, "cold", async (directorySignal) => {
      await initialize?.(() =>
        assertNotCompromised(directorySignal, paths.directory),
      );
      return withLock(paths.index, "cold", async (indexSignal) =>
        operation(() => {
          assertNotCompromised(directorySignal, paths.directory);
          assertNotCompromised(indexSignal, paths.index);
        }),
      );
    });
  }

  private async readIndex(caseId: string): Promise<CaseIndex> {
    try {
      const indexPath = await requireProjectLocalRegularFile(this.projectRoot, [
        ".ai-qa",
        "cases",
        caseId,
        "case.yaml",
      ]);
      const value: unknown = parse(await readFile(indexPath, "utf8"));
      const index = caseIndexSchema.parse(value);
      if (index.id !== caseId) throw new Error("case index identity mismatch");
      return index;
    } catch (error: unknown) {
      if (
        isNodeError(error, "ENOENT") ||
        (error instanceof AiQaError &&
          error.code === "storage.integrity_error" &&
          isMissingStoragePath(error))
      ) {
        throw new AiQaError("case.not_found", "Case does not exist", {
          caseId,
        });
      }
      if (
        error instanceof AiQaError &&
        (error.code === "case.index_integrity_error" ||
          error.code === "storage.integrity_error")
      ) {
        throw error;
      }
      throw new AiQaError(
        "case.index_integrity_error",
        "Case index integrity verification failed",
        { caseId },
      );
    }
  }

  private async writeRevisionOnce(
    path: string,
    revision: CaseRevision,
    onCreate: () => void,
    preCommit: () => void,
  ): Promise<void> {
    let handle;
    try {
      preCommit();
      handle = await open(path, "wx", 0o600);
      onCreate();
      await handle.writeFile(
        stringify(revision, { sortMapEntries: true }),
        "utf8",
      );
      await handle.sync();
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) {
        throw new AiQaError(
          "case.revision_already_exists",
          "Case revision file already exists",
          { path },
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }
}

function isMissingStoragePath(error: AiQaError): boolean {
  return errorCauseCode(error) === "ENOENT";
}
