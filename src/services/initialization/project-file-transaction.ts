import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
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

interface TransactionEntry {
  relativePath: string;
  destination: string;
  content: string;
  original: OptionalProjectLocalFile;
  stagePath: string;
  backupPath?: string;
}

export async function applyProjectFileTransaction(input: {
  projectRoot: string;
  writes: readonly ProjectFileWrite[];
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
    const original = await inspectOptionalProjectLocalRegularFile(
      input.projectRoot,
      write.relativeSegments,
    );
    entries.push({
      relativePath: relativePaths[index]!,
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

  const ownedStages = new Set<string>();
  const ownedBackups = new Set<string>();
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
      await rename(entry.stagePath, entry.destination);
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
    for (const path of [...ownedStages, ...ownedBackups]) {
      await unlinkIfExists(path);
    }
  }
}

async function writeOwnedFile(
  path: string,
  content: string,
  ownedPaths: Set<string>,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  ownedPaths.add(path);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
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
