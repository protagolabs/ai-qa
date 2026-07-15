import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import {
  ensureProjectLocalDirectory,
  inspectOptionalProjectLocalRegularFile,
  type OptionalProjectLocalFile,
} from "../../core/fs/project-storage.js";

export interface ProjectFileWrite {
  relativeSegments: readonly string[];
  content: string;
}

export interface ProjectFileTransactionHooks {
  beforePublish?: (input: {
    relativePath: string;
    publishIndex: number;
  }) => Promise<void>;
}

export interface ProjectFileDestinationSnapshot {
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

interface TransactionEntry {
  relativePath: string;
  destination: string;
  content: string;
  original: OptionalProjectLocalFile;
  stagePath: string;
  backupPath?: string;
}

interface OwnedFileIdentity {
  dev: bigint;
  ino: bigint;
}

export async function applyProjectFileTransaction(input: {
  projectRoot: string;
  writes: readonly ProjectFileWrite[];
  expectedDestinations: readonly ProjectFileDestinationSnapshot[];
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

  const entries: TransactionEntry[] = [];
  for (const [index, write] of input.writes.entries()) {
    const relativePath = relativePaths[index]!;
    const expected = input.expectedDestinations.find(
      (destination) => destination.relativePath === relativePath,
    );
    if (expected === undefined) {
      throw new AiQaError(
        "setup.checksum_mismatch",
        "Confirmed setup does not include a transaction destination",
        { relativePath },
      );
    }
    const original = await inspectOptionalProjectLocalRegularFile(
      input.projectRoot,
      write.relativeSegments,
    );
    assertDestinationSnapshot(relativePath, original, expected);
    entries.push({
      relativePath,
      destination: original.path,
      content: write.content,
      original,
      stagePath: `${original.path}.${transactionId}.stage`,
    });
  }
  entries.sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );

  const ownedStages = new Map<string, OwnedFileIdentity>();
  const ownedBackups = new Map<string, OwnedFileIdentity>();
  const published: TransactionEntry[] = [];
  let caughtError: unknown;
  try {
    for (const write of input.writes) {
      await ensureProjectLocalDirectory(
        input.projectRoot,
        write.relativeSegments.slice(0, -1),
      );
    }
    for (const entry of entries) {
      await writeOwnedFile(entry.stagePath, entry.content, ownedStages);
    }
    for (const entry of entries) {
      if (entry.original.state !== "regular") continue;
      const backupPath = `${entry.destination}.${transactionId}.backup`;
      entry.backupPath = backupPath;
      await writeOwnedFile(backupPath, entry.original.content!, ownedBackups);
    }
    for (const [publishIndex, entry] of entries.entries()) {
      await input.hooks?.beforePublish?.({
        relativePath: entry.relativePath,
        publishIndex,
      });
      const expected = input.expectedDestinations.find(
        (destination) => destination.relativePath === entry.relativePath,
      )!;
      const current = await inspectOptionalProjectLocalRegularFile(
        input.projectRoot,
        entry.relativePath.split("/"),
      );
      assertDestinationSnapshot(entry.relativePath, current, expected);
      await rename(entry.stagePath, entry.destination);
      ownedStages.delete(entry.stagePath);
      published.push(entry);
      await syncDirectory(dirname(entry.destination));
    }
  } catch (error: unknown) {
    caughtError = error;
    try {
      for (const entry of published.reverse()) {
        if (entry.original.state === "missing") {
          await unlinkIfExists(entry.destination);
        } else {
          await rename(entry.backupPath!, entry.destination);
          ownedBackups.delete(entry.backupPath!);
        }
        await syncDirectory(dirname(entry.destination));
      }
    } catch (rollbackError: unknown) {
      throw new AiQaError(
        "storage.rollback_failed",
        "Project file transaction could not restore the original files",
        {
          cause: errorMessage(caughtError),
          rollbackCause: errorMessage(rollbackError),
        },
      );
    }
    throw caughtError;
  } finally {
    for (const [path, identity] of [...ownedStages, ...ownedBackups]) {
      await unlinkIfOwned(path, identity);
    }
  }
}

function assertDestinationSnapshot(
  relativePath: string,
  file: OptionalProjectLocalFile,
  expected: ProjectFileDestinationSnapshot,
): void {
  const actual = destinationSnapshot(relativePath, file);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new AiQaError(
      "setup.checksum_mismatch",
      "Project setup destination changed after confirmation",
      { relativePath, expected, actual },
    );
  }
}

function destinationSnapshot(
  relativePath: string,
  file: OptionalProjectLocalFile,
): ProjectFileDestinationSnapshot {
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
    contentSha256: `sha256:${createHash("sha256")
      .update(file.content!)
      .digest("hex")}`,
  };
}

async function writeOwnedFile(
  path: string,
  content: string,
  ownedPaths: Map<string, OwnedFileIdentity>,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    const stats = await handle.stat({ bigint: true });
    ownedPaths.set(path, { dev: stats.dev, ino: stats.ino });
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfOwned(
  path: string,
  identity: OwnedFileIdentity,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (
    stats.isSymbolicLink() ||
    stats.dev !== identity.dev ||
    stats.ino !== identity.ino
  ) {
    return;
  }
  await unlink(path);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
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
