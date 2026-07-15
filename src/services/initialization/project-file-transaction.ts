import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import {
  ensureProjectLocalDirectory,
  inspectOptionalProjectLocalRegularFile,
  type OptionalProjectLocalFile,
} from "../../core/fs/project-storage.js";
import { readRepositoryIdentity } from "../trust/repository-identity.js";

export interface ProjectFileWrite {
  relativeSegments: readonly string[];
  content: string;
}

interface ProjectFileTransactionHooks {
  beforePublish?: (input: {
    relativePath: string;
    publishIndex: number;
  }) => Promise<void>;
  afterPublish?: (input: {
    relativePath: string;
    publishIndex: number;
  }) => Promise<void>;
  afterDestinationCheck?: (input: {
    phase: "publish" | "rollback";
    relativePath: string;
  }) => Promise<void>;
}

export interface ProjectFileReadSnapshot {
  relativePath: string;
  state: "missing" | "regular";
  identity?: {
    device: string;
    inode: string;
    size: string;
    modifiedNanoseconds: string;
  };
  contentSha256?: string;
}

export interface ProjectRepositoryReadSnapshot {
  canonicalPath: string;
  fingerprint: string;
}

export interface ProjectFileTransactionReadSet {
  repository: ProjectRepositoryReadSnapshot;
  files: readonly ProjectFileReadSnapshot[];
}

interface TransactionEntry {
  relativePath: string;
  destination: string;
  original: OptionalProjectLocalFile;
  stagePath: string;
  stageExpectation?: OwnedFileExpectation;
  backupPath?: string;
  backupExpectation?: OwnedFileExpectation;
  originalPath: string;
  originalVerified: boolean;
  publishedExpectation?: OwnedFileExpectation;
  rollbackPath: string;
}

interface OwnedFileExpectation {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  contentSha256: string;
  content: string;
}

interface TransactionNamespace {
  root: string;
  relativeRoot: string;
  artifacts: Set<string>;
  recovery: Set<string>;
}

interface FailureDetail {
  phase: string;
  relativePath: string;
  cause: string;
}

export async function applyProjectFileTransaction(input: {
  projectRoot: string;
  writes: readonly ProjectFileWrite[];
  readSet: ProjectFileTransactionReadSet;
  hooks?: ProjectFileTransactionHooks;
}): Promise<void> {
  const transactionId = randomUUID();
  const relativePaths = input.writes.map(({ relativeSegments }) =>
    relativeSegments.join("/"),
  );
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw new AiQaError(
      "storage.integrity_error",
      "Project file transaction contains a duplicate destination",
    );
  }

  const expectedReads = new Map(
    input.readSet.files.map((snapshot) => [snapshot.relativePath, snapshot]),
  );
  if (expectedReads.size !== input.readSet.files.length) {
    throw new AiQaError(
      "storage.integrity_error",
      "Project file transaction contains a duplicate read dependency",
    );
  }
  for (const relativePath of relativePaths) {
    if (!expectedReads.has(relativePath)) {
      throw new AiQaError(
        "setup.checksum_mismatch",
        "Confirmed setup read set does not include a transaction destination",
        { relativePath },
      );
    }
  }

  await assertRepositoryRead(input.projectRoot, input.readSet.repository);
  const initialReads = new Map<string, OptionalProjectLocalFile>();
  for (const expected of input.readSet.files) {
    const current = await inspectOptionalProjectLocalRegularFile(
      input.projectRoot,
      expected.relativePath.split("/"),
    );
    assertFileRead(expected.relativePath, current, expected);
    initialReads.set(expected.relativePath, current);
  }

  const namespace = await createTransactionNamespace(
    input.projectRoot,
    transactionId,
  );
  const entries: TransactionEntry[] = [];
  for (const index of input.writes.keys()) {
    const relativePath = relativePaths[index]!;
    const original = initialReads.get(relativePath)!;
    entries.push({
      relativePath,
      destination: original.path,
      original,
      stagePath: "",
      originalPath: "",
      originalVerified: false,
      rollbackPath: "",
    });
  }
  entries.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );
  for (const [index, entry] of entries.entries()) {
    const prefix = `write-${index.toString().padStart(4, "0")}`;
    entry.stagePath = join(namespace.root, `${prefix}.stage`);
    entry.originalPath = join(namespace.root, `${prefix}.original.recovery`);
    entry.rollbackPath = join(namespace.root, `${prefix}.rollback.recovery`);
  }
  const entriesByRelativePath = new Map(
    entries.map((entry) => [entry.relativePath, entry]),
  );
  const writesByRelativePath = new Map(
    input.writes.map((write) => [write.relativeSegments.join("/"), write]),
  );
  const rollbackEntries: TransactionEntry[] = [];
  const rollbackFailures: FailureDetail[] = [];
  let primaryError: unknown;

  try {
    for (const write of input.writes) {
      await ensureProjectLocalDirectory(
        input.projectRoot,
        write.relativeSegments.slice(0, -1),
      );
    }
    for (const entry of entries) {
      entry.stageExpectation = await writePrivateFile(
        entry.stagePath,
        writesByRelativePath.get(entry.relativePath)!.content,
        namespace,
      );
    }
    for (const [index, entry] of entries.entries()) {
      if (entry.original.state !== "regular") continue;
      entry.backupPath = join(
        namespace.root,
        `write-${index.toString().padStart(4, "0")}.backup.recovery`,
      );
      entry.backupExpectation = await writePrivateFile(
        entry.backupPath,
        entry.original.content!,
        namespace,
      );
    }

    for (const [publishIndex, entry] of entries.entries()) {
      await input.hooks?.beforePublish?.({
        relativePath: entry.relativePath,
        publishIndex,
      });
      await assertTransactionReadSet(
        input.projectRoot,
        input.readSet,
        entriesByRelativePath,
      );
      await input.hooks?.afterDestinationCheck?.({
        phase: "publish",
        relativePath: entry.relativePath,
      });

      if (entry.original.state === "regular") {
        await rename(entry.destination, entry.originalPath);
        namespace.artifacts.add(entry.originalPath);
        if (
          !(await privateFileMatchesSnapshot(
            entry.originalPath,
            entry.relativePath,
            expectedReads.get(entry.relativePath)!,
          ))
        ) {
          namespace.recovery.add(entry.originalPath);
          const restoreFailure = await restoreNoReplace(
            entry.originalPath,
            entry.destination,
          );
          if (restoreFailure !== undefined) {
            rollbackFailures.push({
              phase: "publish-conflict-restore",
              relativePath: entry.relativePath,
              cause: restoreFailure,
            });
          }
          throw new AiQaError(
            "storage.integrity_error",
            "Project setup destination changed during publish",
            { relativePath: entry.relativePath },
          );
        }
        entry.originalVerified = true;
        rollbackEntries.push(entry);
      }

      await assertOwnedFile(entry.stagePath, entry.stageExpectation!, "stage");
      try {
        await link(entry.stagePath, entry.destination);
      } catch (error: unknown) {
        if (isNodeError(error, "EEXIST")) {
          throw new AiQaError(
            "setup.checksum_mismatch",
            "Project setup destination changed during publish",
            { relativePath: entry.relativePath },
          );
        }
        throw error;
      }
      entry.publishedExpectation = entry.stageExpectation!;
      if (!rollbackEntries.includes(entry)) rollbackEntries.push(entry);
      await syncDirectory(dirname(entry.destination));
      await input.hooks?.afterPublish?.({
        relativePath: entry.relativePath,
        publishIndex,
      });
      await assertTransactionReadSet(
        input.projectRoot,
        input.readSet,
        entriesByRelativePath,
      );
    }
  } catch (error: unknown) {
    primaryError = error;
    rollbackFailures.push(
      ...(await rollbackBestEffort(rollbackEntries, namespace, input.hooks)),
    );
  }

  const cleanupFailures = await cleanupTransactionNamespace(namespace);
  if (primaryError !== undefined) {
    if (rollbackFailures.length > 0 || namespace.recovery.size > 0) {
      throw rollbackFailed(
        primaryError,
        rollbackFailures,
        cleanupFailures,
        namespace,
      );
    }
    throw primaryErrorWithCleanupFailures(primaryError, cleanupFailures);
  }
  if (cleanupFailures.length > 0) {
    throw new AiQaError(
      "storage.cleanup_failed",
      "Project file transaction could not clean its private artifacts",
      { cleanupCauses: cleanupFailures },
    );
  }
}

async function createTransactionNamespace(
  projectRoot: string,
  transactionId: string,
): Promise<TransactionNamespace> {
  const relativeRoot = `.ai-qa/.transactions/${transactionId}`;
  const parent = await ensureProjectLocalDirectory(projectRoot, [
    ".ai-qa",
    ".transactions",
  ]);
  const root = join(parent, transactionId);
  await mkdir(root, { mode: 0o700 });
  return {
    root,
    relativeRoot,
    artifacts: new Set(),
    recovery: new Set(),
  };
}

async function assertTransactionReadSet(
  projectRoot: string,
  readSet: ProjectFileTransactionReadSet,
  entriesByRelativePath: ReadonlyMap<string, TransactionEntry>,
): Promise<void> {
  await assertRepositoryRead(projectRoot, readSet.repository);
  for (const expected of readSet.files) {
    const write = entriesByRelativePath.get(expected.relativePath);
    if (write?.publishedExpectation !== undefined) {
      await assertOwnedFile(
        write.destination,
        write.publishedExpectation,
        "published destination",
      );
      continue;
    }
    const current = await inspectOptionalProjectLocalRegularFile(
      projectRoot,
      expected.relativePath.split("/"),
    );
    assertFileRead(expected.relativePath, current, expected);
  }
}

async function assertRepositoryRead(
  projectRoot: string,
  expected: ProjectRepositoryReadSnapshot,
): Promise<void> {
  const identity = await readRepositoryIdentity(projectRoot);
  const actual: ProjectRepositoryReadSnapshot = {
    canonicalPath: identity.canonicalPath,
    fingerprint: identity.fingerprint,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new AiQaError(
      "setup.checksum_mismatch",
      "Project repository identity changed after confirmation",
      { expected, actual },
    );
  }
}

async function rollbackBestEffort(
  entries: readonly TransactionEntry[],
  namespace: TransactionNamespace,
  hooks?: ProjectFileTransactionHooks,
): Promise<FailureDetail[]> {
  const failures: FailureDetail[] = [];
  for (const entry of [...entries].reverse()) {
    try {
      failures.push(...(await rollbackEntry(entry, namespace, hooks)));
    } catch (error: unknown) {
      failures.push({
        phase: "rollback-unexpected",
        relativePath: entry.relativePath,
        cause: errorMessage(error),
      });
    }
  }
  return failures;
}

async function rollbackEntry(
  entry: TransactionEntry,
  namespace: TransactionNamespace,
  hooks?: ProjectFileTransactionHooks,
): Promise<FailureDetail[]> {
  const failures: FailureDetail[] = [];
  if (entry.publishedExpectation !== undefined) {
    let ownershipVerified = false;
    try {
      await assertOwnedFile(
        entry.destination,
        entry.publishedExpectation,
        "published destination",
      );
      ownershipVerified = true;
    } catch {
      ownershipVerified = false;
    }
    if (ownershipVerified) {
      await hooks?.afterDestinationCheck?.({
        phase: "rollback",
        relativePath: entry.relativePath,
      });
    }
    try {
      await rename(entry.destination, entry.rollbackPath);
      namespace.artifacts.add(entry.rollbackPath);
      if (
        !(await privateFileMatchesExpectation(
          entry.rollbackPath,
          entry.publishedExpectation,
        ))
      ) {
        namespace.recovery.add(entry.rollbackPath);
        failures.push({
          phase: "rollback-ownership",
          relativePath: entry.relativePath,
          cause: "Published destination was replaced by external content",
        });
      }
    } catch (error: unknown) {
      failures.push({
        phase: "rollback-move",
        relativePath: entry.relativePath,
        cause: errorMessage(error),
      });
    }
  }

  if (
    entry.original.state === "regular" &&
    entry.originalVerified &&
    entry.backupPath !== undefined &&
    entry.backupExpectation !== undefined
  ) {
    if (
      !(await privateFileMatchesExpectation(
        entry.backupPath,
        entry.backupExpectation,
      ))
    ) {
      namespace.recovery.add(entry.backupPath);
      namespace.recovery.add(entry.originalPath);
      failures.push({
        phase: "rollback-backup",
        relativePath: entry.relativePath,
        cause: "Transaction backup changed before restore",
      });
      return failures;
    }
    const restoreFailure = await restoreNoReplace(
      entry.backupPath,
      entry.destination,
    );
    if (restoreFailure !== undefined) {
      namespace.recovery.add(entry.backupPath);
      failures.push({
        phase: "rollback-restore",
        relativePath: entry.relativePath,
        cause: restoreFailure,
      });
    } else {
      try {
        await syncDirectory(dirname(entry.destination));
      } catch (error: unknown) {
        failures.push({
          phase: "rollback-sync",
          relativePath: entry.relativePath,
          cause: errorMessage(error),
        });
      }
    }
  }
  return failures;
}

async function restoreNoReplace(
  recoveryPath: string,
  destination: string,
): Promise<string | undefined> {
  try {
    const stats = await lstat(recoveryPath);
    if (stats.isSymbolicLink()) {
      await symlink(await readlink(recoveryPath), destination);
    } else if (stats.isFile()) {
      await link(recoveryPath, destination);
    } else {
      return "Recovery artifact is not a regular file or symbolic link";
    }
    return undefined;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

async function cleanupTransactionNamespace(
  namespace: TransactionNamespace,
): Promise<FailureDetail[]> {
  const failures: FailureDetail[] = [];
  for (const path of namespace.artifacts) {
    if (namespace.recovery.has(path)) continue;
    try {
      await unlink(path);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) continue;
      failures.push({
        phase: "cleanup-unlink",
        relativePath: artifactRelativePath(namespace, path),
        cause: errorMessage(error),
      });
    }
  }
  if (namespace.recovery.size === 0) {
    try {
      await rmdir(namespace.root);
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) {
        failures.push({
          phase: "cleanup-directory",
          relativePath: namespace.relativeRoot,
          cause: errorMessage(error),
        });
      }
    }
  }
  return failures;
}

function primaryErrorWithCleanupFailures(
  primaryError: unknown,
  cleanupFailures: readonly FailureDetail[],
): Error {
  const primary =
    primaryError instanceof Error
      ? primaryError
      : new Error("Unknown project file transaction error");
  if (cleanupFailures.length === 0) return primary;
  if (primary instanceof AiQaError) {
    const enriched = new AiQaError(primary.code, primary.message, {
      ...primary.details,
      cleanupCauses: cleanupFailures,
    });
    if (primary.stack !== undefined) enriched.stack = primary.stack;
    return enriched;
  }
  try {
    Object.defineProperty(primary, "cleanupCauses", {
      configurable: true,
      enumerable: true,
      value: cleanupFailures,
    });
    return primary;
  } catch {
    const enriched = new Error(primary.message, { cause: primary });
    enriched.name = primary.name;
    Object.defineProperty(enriched, "cleanupCauses", {
      enumerable: true,
      value: cleanupFailures,
    });
    return enriched;
  }
}

function rollbackFailed(
  primaryError: unknown,
  rollbackFailures: readonly FailureDetail[],
  cleanupFailures: readonly FailureDetail[],
  namespace: TransactionNamespace,
): AiQaError {
  return new AiQaError(
    "storage.rollback_failed",
    "Project file transaction could not restore every original destination",
    {
      cause: errorMessage(primaryError),
      rollbackCauses: rollbackFailures,
      ...(cleanupFailures.length === 0
        ? {}
        : { cleanupCauses: cleanupFailures }),
      recoveryPaths: [...namespace.recovery].map((path) =>
        artifactRelativePath(namespace, path),
      ),
    },
  );
}

function artifactRelativePath(
  namespace: TransactionNamespace,
  path: string,
): string {
  return `${namespace.relativeRoot}/${path.slice(namespace.root.length + 1)}`;
}

function assertFileRead(
  relativePath: string,
  file: OptionalProjectLocalFile,
  expected: ProjectFileReadSnapshot,
): void {
  const actual = fileReadSnapshot(relativePath, file);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new AiQaError(
      "setup.checksum_mismatch",
      "Project setup read dependency changed after confirmation",
      { relativePath, expected, actual },
    );
  }
}

function fileReadSnapshot(
  relativePath: string,
  file: OptionalProjectLocalFile,
): ProjectFileReadSnapshot {
  if (file.state === "missing") return { relativePath, state: "missing" };
  return {
    relativePath,
    state: "regular",
    identity: {
      device: file.stats!.dev.toString(),
      inode: file.stats!.ino.toString(),
      size: file.stats!.size.toString(),
      modifiedNanoseconds: file.stats!.mtimeNs.toString(),
    },
    contentSha256: sha256(Buffer.from(file.content!, "utf8")),
  };
}

async function privateFileMatchesSnapshot(
  path: string,
  relativePath: string,
  expected: ProjectFileReadSnapshot,
): Promise<boolean> {
  try {
    const actual = await inspectOwnedFile(path, "moved destination");
    return (
      canonicalJson({
        relativePath,
        state: "regular",
        identity: {
          device: actual.dev.toString(),
          inode: actual.ino.toString(),
          size: actual.size.toString(),
          modifiedNanoseconds: actual.mtimeNs.toString(),
        },
        contentSha256: actual.contentSha256,
      }) === canonicalJson(expected)
    );
  } catch {
    return false;
  }
}

async function privateFileMatchesExpectation(
  path: string,
  expected: OwnedFileExpectation,
): Promise<boolean> {
  try {
    await assertOwnedFile(path, expected, "moved destination");
    return true;
  } catch {
    return false;
  }
}

async function writePrivateFile(
  path: string,
  content: string,
  namespace: TransactionNamespace,
): Promise<OwnedFileExpectation> {
  const handle = await open(path, "wx", 0o600);
  namespace.artifacts.add(path);
  try {
    await handle.stat({ bigint: true });
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    return {
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      contentSha256: sha256(Buffer.from(content, "utf8")),
      content,
    };
  } finally {
    await handle.close();
  }
}

async function assertOwnedFile(
  path: string,
  expected: OwnedFileExpectation,
  purpose: OwnedFilePurpose,
): Promise<void> {
  const actual = await inspectOwnedFile(path, purpose);
  const expectedBytes = Buffer.from(expected.content, "utf8");
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeNs !== expected.mtimeNs ||
    actual.contentSha256 !== expected.contentSha256 ||
    !actual.content.equals(expectedBytes)
  ) {
    throw ownedFileIntegrityError(path, purpose);
  }
}

interface InspectedOwnedFile {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  contentSha256: string;
  content: Buffer;
}

async function inspectOwnedFile(
  path: string,
  purpose: OwnedFilePurpose,
): Promise<InspectedOwnedFile> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const beforeRead = await handle.stat({ bigint: true });
    if (!beforeRead.isFile()) {
      throw ownedFileIntegrityError(path, purpose);
    }
    const content = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    if (
      beforeRead.dev !== afterRead.dev ||
      beforeRead.ino !== afterRead.ino ||
      beforeRead.size !== afterRead.size ||
      beforeRead.mtimeNs !== afterRead.mtimeNs
    ) {
      throw ownedFileIntegrityError(path, purpose);
    }
    const pathStats = await lstat(path, { bigint: true });
    if (
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      pathStats.dev !== afterRead.dev ||
      pathStats.ino !== afterRead.ino ||
      (await realpath(path)) !== path
    ) {
      throw ownedFileIntegrityError(path, purpose);
    }
    return {
      dev: afterRead.dev,
      ino: afterRead.ino,
      size: afterRead.size,
      mtimeNs: afterRead.mtimeNs,
      contentSha256: sha256(content),
      content,
    };
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw ownedFileIntegrityError(path, purpose, nodeErrorCode(error));
  } finally {
    await handle?.close();
  }
}

function ownedFileIntegrityError(
  path: string,
  purpose: OwnedFilePurpose,
  causeCode?: string,
): AiQaError {
  return new AiQaError(
    "storage.integrity_error",
    `Project transaction ${purpose} file changed unexpectedly`,
    { path, purpose, ...(causeCode === undefined ? {} : { causeCode }) },
  );
}

type OwnedFilePurpose =
  "stage" | "backup" | "published destination" | "moved destination";

function sha256(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown transaction error";
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}
