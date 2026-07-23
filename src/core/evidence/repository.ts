import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { EVIDENCE_SCHEMA_VERSION } from "../../schemas/versions.js";
import { canonicalJson } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { readJsonLines, writeJsonLines } from "../fs/json-lines.js";
import { assertNotCompromised, withLock } from "../fs/locking.js";
import { createId } from "../ids.js";
import { controllerForPlatform } from "../platforms/registry.js";
import {
  controllerSchema,
  type Controller,
  type Platform,
} from "../platforms/schema.js";
import { actionIdSchema, runIdSchema } from "../runs/schema.js";
import { evidenceRecordSchema, type EvidenceRecord } from "./schema.js";

export interface RegisterRawEvidenceInput {
  sourcePath: string;
  mediaType: string;
  sourceTool: Controller;
  sensitivity: "public" | "internal" | "sensitive";
  evidenceKinds: string[];
  captureActionId: string;
  idempotencyKey: string;
}

export const registerRawEvidenceInputSchema: z.ZodType<RegisterRawEvidenceInput> =
  z
    .object({
      sourcePath: z.string().min(1),
      mediaType: z.string().trim().min(1),
      sourceTool: controllerSchema,
      sensitivity: z.enum(["public", "internal", "sensitive"]),
      evidenceKinds: z.array(z.string().trim().min(1)).min(1),
      captureActionId: actionIdSchema,
      idempotencyKey: z.string().trim().min(1),
    })
    .strict();

interface EvidencePaths {
  root: string;
  files: string;
  index: string;
}

function requireDescendant(root: string, candidate: string): string {
  const child = relative(root, candidate);
  if (
    child.length === 0 ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new AiQaError(
      "evidence.integrity_error",
      "Evidence path must stay inside the run evidence root",
    );
  }
  return candidate;
}

function resolveEvidencePaths(
  projectRoot: string,
  runId: string,
): EvidencePaths {
  const validatedRunId = runIdSchema.parse(runId);
  const evidenceRoot = resolve(projectRoot, ".ai-qa", "evidence");
  const root = requireDescendant(
    evidenceRoot,
    resolve(evidenceRoot, validatedRunId),
  );
  return {
    root,
    files: requireDescendant(root, resolve(root, "files")),
    index: requireDescendant(root, resolve(root, "index.jsonl")),
  };
}

function sanitizeBasename(path: string): string {
  const sanitized = basename(path).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized.length === 0 ? "evidence" : sanitized;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function persistedInput(record: EvidenceRecord): object {
  return {
    mediaType: record.mediaType,
    sourceTool: record.sourceTool,
    sensitivity: record.sensitivity,
    evidenceKinds: record.evidenceKinds,
    captureActionId: record.captureActionId,
    idempotencyKey: record.idempotencyKey,
    contentHash: record.contentHash,
    platform: record.platform,
  };
}

export class EvidenceRepository {
  private readonly projectRoot: string;
  private readonly runId: string;
  private readonly now: () => Date;
  private readonly platform: Platform;
  private readonly paths: EvidencePaths;

  constructor(
    projectRoot: string,
    runId: string,
    now: () => Date,
    platform: Platform,
  ) {
    this.projectRoot = resolve(projectRoot);
    this.runId = runIdSchema.parse(runId);
    this.now = now;
    this.platform = platform;
    this.paths = resolveEvidencePaths(this.projectRoot, this.runId);
  }

  async registerRaw(
    input: RegisterRawEvidenceInput,
    options: { preCommit?: () => void } = {},
  ): Promise<EvidenceRecord> {
    input = registerRawEvidenceInputSchema.parse(input);
    const expectedController = controllerForPlatform(this.platform);
    if (input.sourceTool !== expectedController) {
      throw new AiQaError(
        "evidence.controller_mismatch",
        "Evidence provenance must match the immutable run platform",
        {
          runId: this.runId,
          platform: this.platform,
          expectedController,
          evidencePlatform: this.platform,
          sourceTool: input.sourceTool,
        },
      );
    }
    await this.ensureStorageRoots();
    return withLock(this.paths.index, "cold", async (signal) => {
      const preCommit = () => {
        options.preCommit?.();
        assertNotCompromised(signal, this.paths.index);
      };
      await this.ensureIndex(preCommit);
      let copiedPath: string | undefined;
      let ownsCopiedPath = false;
      try {
        const records = await this.readAll();
        const sourceHash = sha256(await readFile(input.sourcePath));
        const existing = records.find(
          (record) => record.idempotencyKey === input.idempotencyKey,
        );
        if (existing !== undefined) {
          const requested = {
            mediaType: input.mediaType,
            sourceTool: input.sourceTool,
            sensitivity: input.sensitivity,
            evidenceKinds: input.evidenceKinds,
            captureActionId: input.captureActionId,
            idempotencyKey: input.idempotencyKey,
            contentHash: sourceHash,
            platform: this.platform,
          };
          if (
            canonicalJson(persistedInput(existing)) === canonicalJson(requested)
          ) {
            await this.verifyRecord(existing);
            return existing;
          }
          throw new AiQaError(
            "evidence.idempotency_conflict",
            "Evidence idempotency key was already used for different input",
            { idempotencyKey: input.idempotencyKey },
          );
        }

        const id = createId("evidence");
        const fileName = `${id}-${sanitizeBasename(input.sourcePath)}`;
        copiedPath = requireDescendant(
          this.paths.root,
          resolve(this.paths.files, fileName),
        );
        preCommit();
        await copyFile(input.sourcePath, copiedPath, constants.COPYFILE_EXCL);
        ownsCopiedPath = true;
        const contentHash = sha256(await readFile(copiedPath));
        const record = evidenceRecordSchema.parse({
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          id,
          runId: this.runId,
          projectRelativePath: relative(this.projectRoot, copiedPath)
            .split(sep)
            .join("/"),
          contentHash,
          mediaType: input.mediaType,
          platform: this.platform,
          sourceTool: input.sourceTool,
          capturedAt: this.now().toISOString(),
          classification: "raw",
          sensitivity: input.sensitivity,
          evidenceKinds: input.evidenceKinds,
          captureActionId: input.captureActionId,
          idempotencyKey: input.idempotencyKey,
        });

        await writeJsonLines(this.paths.index, [...records, record], {
          preCommit,
        });
        ownsCopiedPath = false;
        return record;
      } catch (error: unknown) {
        if (copiedPath !== undefined && ownsCopiedPath) {
          try {
            await rm(copiedPath);
          } catch {
            // Preserve the registration failure.
          }
        }
        throw error;
      }
    });
  }

  async readAll(): Promise<EvidenceRecord[]> {
    try {
      await this.validateIndexIfPresent();
      return await readJsonLines(this.paths.index, evidenceRecordSchema);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
  }

  async verifyAll(): Promise<EvidenceRecord[]> {
    try {
      const records = await this.readAll();
      for (const record of records) {
        if (record.runId !== this.runId) throw new Error("run mismatch");
        await this.verifyRecord(record);
      }
      return records;
    } catch (error: unknown) {
      if (
        error instanceof AiQaError &&
        error.code === "evidence.integrity_error"
      ) {
        throw error;
      }
      throw new AiQaError(
        "evidence.integrity_error",
        "Evidence integrity verification failed",
        { runId: this.runId },
      );
    }
  }

  private async verifyRecord(record: EvidenceRecord): Promise<void> {
    if (
      record.platform !== this.platform ||
      record.sourceTool !== controllerForPlatform(this.platform)
    ) {
      throw new AiQaError(
        "evidence.integrity_error",
        "Evidence provenance does not match the run platform",
        {
          runId: this.runId,
          platform: this.platform,
          evidencePlatform: record.platform,
          sourceTool: record.sourceTool,
        },
      );
    }
    const path = await this.resolveIndexedPath(record.projectRelativePath);
    const actualHash = sha256(await readFile(path));
    if (actualHash !== record.contentHash) {
      throw new AiQaError(
        "evidence.integrity_error",
        "Evidence content hash verification failed",
        {
          evidenceId: record.id,
          expectedHash: record.contentHash,
          actualHash,
        },
      );
    }
  }

  private async resolveIndexedPath(
    projectRelativePath: string,
  ): Promise<string> {
    if (projectRelativePath.includes("\\")) {
      throw new Error("Evidence paths must use POSIX separators");
    }
    const candidate = resolve(this.projectRoot, projectRelativePath);
    const normalizedRelative = relative(this.projectRoot, candidate)
      .split(sep)
      .join("/");
    if (normalizedRelative !== projectRelativePath) {
      throw new Error("Evidence path must be a normalized relative path");
    }
    requireDescendant(this.paths.files, candidate);
    const stats = await lstat(candidate);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Evidence path must be a regular file");
    }
    const roots = await this.validateStorageRoots();
    requireDescendant(roots.files, await realpath(candidate));
    return candidate;
  }

  private async validateIndexIfPresent(): Promise<void> {
    let stats;
    try {
      stats = await lstat(this.paths.index);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new AiQaError(
        "evidence.integrity_error",
        "Evidence index must be a regular file",
        { runId: this.runId },
      );
    }
    const roots = await this.validateStorageRoots();
    requireDescendant(roots.root, await realpath(this.paths.index));
  }

  private async ensureIndex(preCommit: () => void): Promise<void> {
    let handle;
    try {
      preCommit();
      handle = await open(this.paths.index, "wx", 0o600);
      await handle.sync();
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) {
        await this.validateIndexIfPresent();
        return;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async validateStorageRoots(): Promise<{
    root: string;
    files: string;
  }> {
    const canonicalProjectRoot = await realpath(this.projectRoot);
    const paths = this.canonicalStoragePaths(canonicalProjectRoot);
    await this.requireRealDirectory(paths.aiQa);
    await this.requireRealDirectory(paths.evidence);
    await this.requireRealDirectory(paths.root);
    await this.requireRealDirectory(paths.files);
    return { root: paths.root, files: paths.files };
  }

  private async ensureStorageRoots(): Promise<void> {
    const canonicalProjectRoot = await realpath(this.projectRoot);
    const paths = this.canonicalStoragePaths(canonicalProjectRoot);
    await this.ensureRealDirectory(paths.aiQa);
    await this.ensureRealDirectory(paths.evidence);
    await this.ensureRealDirectory(paths.root);
    await this.ensureRealDirectory(paths.files);
  }

  private canonicalStoragePaths(canonicalProjectRoot: string): {
    aiQa: string;
    evidence: string;
    root: string;
    files: string;
  } {
    const aiQa = resolve(canonicalProjectRoot, ".ai-qa");
    const evidence = resolve(aiQa, "evidence");
    const root = resolve(evidence, this.runId);
    const files = resolve(root, "files");
    return { aiQa, evidence, root, files };
  }

  private async ensureRealDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    await this.requireRealDirectory(path);
  }

  private async requireRealDirectory(path: string): Promise<void> {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw invalidStorageRoot(path);
    }
    if ((await realpath(path)) !== path) {
      throw invalidStorageRoot(path);
    }
  }
}

function invalidStorageRoot(path: string): AiQaError {
  return new AiQaError(
    "evidence.integrity_error",
    "Evidence storage roots must be real canonical directories",
    { path },
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
