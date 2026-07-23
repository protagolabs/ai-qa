import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { AiQaError, toErrorCause } from "../errors.js";
import { isNodeError } from "../node-errors.js";
import { syncDirectoryWhereSupported } from "./atomic-write.js";

function validateSegments(segments: readonly string[]): void {
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    throw storageError("Project-local storage segments are invalid");
  }
}

export interface ProjectLocalDirectoryDurabilityHooks {
  afterParentDirectorySync?: (input: {
    parentPath: string;
    childPath: string;
  }) => void | Promise<void>;
}

async function walkDirectories(
  projectRoot: string,
  segments: readonly string[],
  create: boolean,
  durable = false,
  durabilityHooks: ProjectLocalDirectoryDurabilityHooks = {},
): Promise<string> {
  validateSegments(segments);
  let current = await realpath(projectRoot);
  for (const segment of segments) {
    const parent = current;
    current = resolve(current, segment);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error: unknown) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
    }
    try {
      const stats = await lstat(current);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (await realpath(current)) !== current
      ) {
        throw storageError(
          "Project-local storage ancestor is not a real directory",
          current,
        );
      }
    } catch (error: unknown) {
      if (error instanceof AiQaError) throw error;
      throw storageError(
        "Project-local storage directory verification failed",
        current,
        error,
      );
    }
    if (durable) {
      await syncDirectoryWhereSupported(parent);
      await durabilityHooks.afterParentDirectorySync?.({
        parentPath: parent,
        childPath: current,
      });
    }
  }
  return current;
}

export function ensureProjectLocalDirectory(
  projectRoot: string,
  segments: readonly string[],
): Promise<string> {
  return walkDirectories(projectRoot, segments, true);
}

export function ensureProjectLocalDirectoryDurable(
  projectRoot: string,
  segments: readonly string[],
  hooks: ProjectLocalDirectoryDurabilityHooks = {},
): Promise<string> {
  return walkDirectories(projectRoot, segments, true, true, hooks);
}

export function requireProjectLocalDirectory(
  projectRoot: string,
  segments: readonly string[],
): Promise<string> {
  return walkDirectories(projectRoot, segments, false);
}

const staleStagingAgeMs = 60 * 60 * 1000;

export interface SweepStaleStagingHooks {
  afterFinalVerification?: ProjectLocalRemovalHooks["afterFinalVerification"];
}

export async function sweepStaleStaging(
  root: string,
  prefix: string,
  now: () => Date,
  hooks: SweepStaleStagingHooks = {},
): Promise<string[]> {
  if (
    prefix.length === 0 ||
    prefix === "." ||
    prefix === ".." ||
    prefix.includes("/") ||
    prefix.includes("\\")
  ) {
    throw storageError("Staging prefix is invalid", prefix);
  }
  const resolvedRoot = resolve(root);
  let canonicalRoot: string;
  let rootIdentity: ProjectLocalRemovalIdentity;
  try {
    const rootStats = await lstat(resolvedRoot, { bigint: true });
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw storageError("Staging root is not a real directory", resolvedRoot);
    }
    canonicalRoot = await realpath(resolvedRoot);
    if (canonicalRoot !== resolvedRoot) {
      throw storageError("Staging root has a symlinked ancestor", resolvedRoot);
    }
    rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return [];
    if (error instanceof AiQaError) throw error;
    throw storageError("Staging root verification failed", resolvedRoot, error);
  }

  const cutoff = now().getTime() - staleStagingAgeMs;
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(canonicalRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return [];
    throw storageError("Staging root enumeration failed", canonicalRoot, error);
  }
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (
      !entry.name.startsWith(prefix) ||
      entry.isSymbolicLink() ||
      !entry.isDirectory()
    ) {
      continue;
    }
    const path = resolve(canonicalRoot, entry.name);
    if (dirname(path) !== canonicalRoot) continue;
    try {
      await requireUnchangedSweepRoot(canonicalRoot, rootIdentity);
      const prepared = await prepareProjectLocalRemoval({
        projectRoot: canonicalRoot,
        segments: [entry.name],
        expected: "directory",
        ...(hooks.afterFinalVerification === undefined
          ? {}
          : {
              hooks: { afterFinalVerification: hooks.afterFinalVerification },
            }),
      });
      const stats = await lstat(path);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (await realpath(path)) !== path ||
        stats.mtimeMs >= cutoff
      ) {
        continue;
      }
      await requireUnchangedSweepRoot(canonicalRoot, rootIdentity);
      if (await prepared.remove()) removed.push(entry.name);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) continue;
      if (error instanceof AiQaError) throw error;
      throw storageError("Staging directory cleanup failed", path, error);
    }
  }
  return removed;
}

async function requireUnchangedSweepRoot(
  root: string,
  expected: ProjectLocalRemovalIdentity,
): Promise<void> {
  try {
    const current = await lstat(root, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      (await realpath(root)) !== root
    ) {
      throw storageError("Staging root changed during cleanup", root);
    }
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw storageError("Staging root verification failed", root, error);
  }
}

export interface OptionalProjectLocalFile {
  path: string;
  state: "missing" | "regular";
  content?: string;
  stats?: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
  };
}

export interface OptionalProjectLocalInspectionHooks {
  afterPathIdentity?: (input: { path: string }) => Promise<void>;
  afterHandleRead?: (input: { path: string }) => Promise<void>;
}

export interface PreparedProjectLocalRemoval {
  relativePath: string;
  remove(): Promise<boolean>;
}

export interface ProjectLocalRemovalHooks {
  afterFinalVerification?: (input: { path: string }) => Promise<void>;
  beforeClaim?: (input: { path: string }) => void | Promise<void>;
  beforeUnlink?: (input: { path: string }) => void | Promise<void>;
  afterClaim?: (input: { path: string; recoveryPath: string }) => Promise<void>;
  afterClaimDirectoryDurable?: (input: { path: string }) => Promise<void>;
  afterClaimRenameDurable?: (input: { path: string }) => Promise<void>;
  afterClaimUnlinkDurable?: (input: { path: string }) => Promise<void>;
}

export interface ProjectLocalClaimedFileRemovalInput {
  projectRoot: string;
  segments: readonly string[];
  claimDirectorySegments: readonly string[];
  verifyClaimedFile: (path: string) => Promise<void>;
  hooks?: ProjectLocalRemovalHooks;
}

export interface ProjectLocalPublishHooks {
  afterFinalVerification?: (input: {
    path: string;
    temporaryPath: string;
    parentPath: string;
  }) => Promise<void>;
  afterLink?: (input: { path: string }) => Promise<void>;
}

export type ProjectLocalRegularFileMode = "read" | "append" | "read-write";

export interface ProjectLocalRegularFileHooks {
  afterPathIdentity?: (input: { path: string }) => Promise<void>;
}

export interface OpenProjectLocalRegularFile {
  path: string;
  parentPath: string;
  handle: FileHandle;
  revalidate(this: void): Promise<void>;
}

export async function withProjectLocalRegularFile<T>(
  input: {
    projectRoot: string;
    segments: readonly string[];
    mode: ProjectLocalRegularFileMode;
    hooks?: ProjectLocalRegularFileHooks;
  },
  callback: (file: OpenProjectLocalRegularFile) => T | Promise<T>,
): Promise<T> {
  const segments = [...input.segments];
  validateSegments(segments);
  const parentSegments = segments.slice(0, -1);
  const parent = await requireProjectLocalDirectory(
    input.projectRoot,
    parentSegments,
  );
  const parentIdentity = await lstat(parent, { bigint: true });
  const path = resolve(parent, segments.at(-1)!);
  let pathIdentity: BigIntFileIdentity;
  try {
    const stats = await lstat(path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw storageError(
        "Project-local artifact is not a real regular file",
        path,
      );
    }
    pathIdentity = fileIdentity(stats);
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw storageError(
      "Project-local artifact verification failed",
      path,
      error,
    );
  }
  await input.hooks?.afterPathIdentity?.({ path });

  const flags =
    input.mode === "read"
      ? constants.O_RDONLY
      : input.mode === "append"
        ? constants.O_WRONLY | constants.O_APPEND
        : constants.O_RDWR;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, flags | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== pathIdentity.dev ||
      opened.ino !== pathIdentity.ino
    ) {
      throw storageError(
        "Project-local artifact changed before it was opened",
        path,
      );
    }
    const revalidate = async (): Promise<void> => {
      await requireUnchangedProjectLocalParent({
        projectRoot: input.projectRoot,
        parentSegments,
        parent,
        parentIdentity,
      });
      const handleStats = await handle!.stat({ bigint: true });
      const pathStats = await lstat(path, { bigint: true });
      if (
        !handleStats.isFile() ||
        pathStats.isSymbolicLink() ||
        !pathStats.isFile() ||
        handleStats.dev !== pathStats.dev ||
        handleStats.ino !== pathStats.ino
      ) {
        throw storageError(
          "Project-local artifact changed during open-file verification",
          path,
        );
      }
      await requireUnchangedProjectLocalParent({
        projectRoot: input.projectRoot,
        parentSegments,
        parent,
        parentIdentity,
      });
    };
    await revalidate();
    const result = await callback({
      path,
      parentPath: parent,
      handle,
      revalidate,
    });
    await revalidate();
    return result;
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw storageError(
      "Project-local open-existing operation failed",
      path,
      error,
    );
  } finally {
    await handle?.close();
  }
}

export async function synchronizeProjectLocalRegularFile(
  projectRoot: string,
  segments: readonly string[],
): Promise<string> {
  return withProjectLocalRegularFile(
    { projectRoot, segments, mode: "read-write" },
    async ({ path, parentPath, handle, revalidate }) => {
      await revalidate();
      await handle.sync();
      await revalidate();
      await syncDirectoryWhereSupported(parentPath);
      return path;
    },
  );
}

export interface ProjectLocalAtomicReplaceHooks {
  afterFinalVerification?: (input: {
    path: string;
    temporaryPath: string;
    parentPath: string;
  }) => Promise<void>;
}

export async function atomicReplaceProjectLocalRegularFile(input: {
  projectRoot: string;
  segments: readonly string[];
  content: string | Buffer;
  allowMissing?: boolean;
  preCommit?: () => void;
  hooks?: ProjectLocalAtomicReplaceHooks;
}): Promise<string> {
  const segments = [...input.segments];
  validateSegments(segments);
  const parentSegments = segments.slice(0, -1);
  const parent = await requireProjectLocalDirectory(
    input.projectRoot,
    parentSegments,
  );
  const parentIdentity = await lstat(parent, { bigint: true });
  const destination = resolve(parent, segments.at(-1)!);
  const expectedDestination = await inspectReplaceDestination(
    destination,
    input.allowMissing === true,
  );
  const temporaryPath = resolve(
    parent,
    `.${basename(destination)}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  let temporaryIdentity: BigIntFileIdentity | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(input.content);
    await handle.sync();
    const temporaryStats = await handle.stat({ bigint: true });
    if (!temporaryStats.isFile()) {
      throw storageError(
        "Project-local atomic-replace temporary artifact is not a regular file",
        temporaryPath,
      );
    }
    temporaryIdentity = fileIdentity(temporaryStats);
    const verifyCommitState = () =>
      verifyAtomicReplaceCommitState({
        projectRoot: input.projectRoot,
        parentSegments,
        parent,
        parentIdentity,
        destination,
        expectedDestination,
        temporaryPath,
        temporaryIdentity: temporaryIdentity!,
      });
    await verifyCommitState();
    await input.hooks?.afterFinalVerification?.({
      path: destination,
      temporaryPath,
      parentPath: parent,
    });
    await verifyCommitState();
    input.preCommit?.();
    await verifyCommitState();
    await rename(temporaryPath, destination);
    const published = await lstat(destination, { bigint: true });
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      published.dev !== temporaryIdentity.dev ||
      published.ino !== temporaryIdentity.ino
    ) {
      throw storageError(
        "Project-local atomic-replace destination changed during commit",
        destination,
      );
    }
    await requireUnchangedProjectLocalParent({
      projectRoot: input.projectRoot,
      parentSegments,
      parent,
      parentIdentity,
    });
    await syncDirectoryWhereSupported(parent);
    return destination;
  } finally {
    await handle?.close();
    if (temporaryIdentity !== undefined) {
      const current = await lstat(temporaryPath, { bigint: true }).catch(
        () => undefined,
      );
      if (
        current !== undefined &&
        current.dev === temporaryIdentity.dev &&
        current.ino === temporaryIdentity.ino
      ) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }
}

async function inspectReplaceDestination(
  path: string,
  allowMissing: boolean,
): Promise<BigIntFileIdentity | undefined> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw storageError(
        "Project-local atomic-replace destination is not a regular file",
        path,
      );
    }
    return fileIdentity(stats);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT") && allowMissing) return undefined;
    if (error instanceof AiQaError) throw error;
    throw storageError(
      "Project-local atomic-replace destination verification failed",
      path,
      error,
    );
  }
}

async function verifyAtomicReplaceCommitState(input: {
  projectRoot: string;
  parentSegments: readonly string[];
  parent: string;
  parentIdentity: { dev: bigint; ino: bigint };
  destination: string;
  expectedDestination: BigIntFileIdentity | undefined;
  temporaryPath: string;
  temporaryIdentity: BigIntFileIdentity;
}): Promise<void> {
  await requireUnchangedProjectLocalParent(input);
  const temporary = await lstat(input.temporaryPath, { bigint: true });
  if (
    temporary.isSymbolicLink() ||
    !temporary.isFile() ||
    !sameFileIdentity(temporary, input.temporaryIdentity)
  ) {
    throw storageError(
      "Project-local atomic-replace temporary artifact changed",
      input.temporaryPath,
    );
  }
  let destination: BigIntFileIdentity | undefined;
  try {
    const stats = await lstat(input.destination, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw storageError(
        "Project-local atomic-replace destination changed",
        input.destination,
      );
    }
    destination = fileIdentity(stats);
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  if (
    (input.expectedDestination === undefined) !== (destination === undefined) ||
    (input.expectedDestination !== undefined &&
      destination !== undefined &&
      !sameFileIdentity(input.expectedDestination, destination))
  ) {
    throw storageError(
      "Project-local atomic-replace destination changed before commit",
      input.destination,
    );
  }
  await requireUnchangedProjectLocalParent(input);
}

async function requireUnchangedProjectLocalParent(input: {
  projectRoot: string;
  parentSegments: readonly string[];
  parent: string;
  parentIdentity: { dev: bigint; ino: bigint };
}): Promise<void> {
  const verified = await requireProjectLocalDirectory(
    input.projectRoot,
    input.parentSegments,
  );
  const current = await lstat(input.parent, { bigint: true });
  if (
    verified !== input.parent ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== input.parentIdentity.dev ||
    current.ino !== input.parentIdentity.ino
  ) {
    throw storageError(
      "Project-local storage parent changed during commit",
      input.parent,
    );
  }
}

function fileIdentity(stats: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}): BigIntFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
  };
}

export async function publishProjectLocalRegularFile(input: {
  projectRoot: string;
  segments: readonly string[];
  content: Buffer;
  preCommit?: () => void;
  durable?: boolean;
  hooks?: ProjectLocalPublishHooks;
}): Promise<string> {
  validateSegments(input.segments);
  const parentSegments = input.segments.slice(0, -1);
  const parent =
    input.durable === true
      ? await ensureProjectLocalDirectoryDurable(
          input.projectRoot,
          parentSegments,
        )
      : await ensureProjectLocalDirectory(input.projectRoot, parentSegments);
  const parentIdentity = await lstat(parent, { bigint: true });
  const destination = resolve(parent, input.segments.at(-1)!);
  const temporaryPath = resolve(
    parent,
    `.${basename(destination)}.${randomUUID()}.tmp`,
  );
  let handle;
  let temporaryIdentity: BigIntFileIdentity | undefined;
  let destinationLinked = false;
  let publicationComplete = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(input.content);
    await handle.sync();
    const synchronizedTemporary = await handle.stat({ bigint: true });
    if (!synchronizedTemporary.isFile()) {
      throw storageError(
        "Project-local publication temporary artifact is not a regular file",
        temporaryPath,
      );
    }
    temporaryIdentity = {
      dev: synchronizedTemporary.dev,
      ino: synchronizedTemporary.ino,
      size: synchronizedTemporary.size,
      mtimeNs: synchronizedTemporary.mtimeNs,
    };
    await verifyPublicationCommitState({
      projectRoot: input.projectRoot,
      parentSegments,
      parent,
      parentIdentity,
      temporaryPath,
      temporaryIdentity,
      destination,
    });
    await input.hooks?.afterFinalVerification?.({
      path: destination,
      temporaryPath,
      parentPath: parent,
    });
    await verifyPublicationCommitState({
      projectRoot: input.projectRoot,
      parentSegments,
      parent,
      parentIdentity,
      temporaryPath,
      temporaryIdentity,
      destination,
    });
    input.preCommit?.();
    try {
      await link(temporaryPath, destination);
      destinationLinked = true;
    } catch (error: unknown) {
      throw storageError(
        "Project-local publication destination changed before commit",
        destination,
        error,
      );
    }
    await input.hooks?.afterLink?.({ path: destination });
    await verifyPublishedRegularFile({
      projectRoot: input.projectRoot,
      parentSegments,
      parent,
      parentIdentity,
      destination,
      temporaryIdentity,
      expectedContent: input.content,
    });
    await unlink(temporaryPath);
    if (input.durable === true) {
      await syncDirectoryWhereSupported(parent);
    }
    publicationComplete = true;
    return destination;
  } finally {
    await handle?.close();
    if (
      destinationLinked &&
      !publicationComplete &&
      temporaryIdentity !== undefined
    ) {
      await removeCapturedPublication({
        parent,
        parentIdentity,
        destination,
        temporaryIdentity,
        durable: input.durable === true,
      });
    }
    if (temporaryIdentity !== undefined) {
      const currentTemporary = await lstat(temporaryPath, {
        bigint: true,
      }).catch(() => undefined);
      if (
        currentTemporary !== undefined &&
        currentTemporary.dev === temporaryIdentity.dev &&
        currentTemporary.ino === temporaryIdentity.ino
      ) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }
}

async function verifyPublishedRegularFile(input: {
  projectRoot: string;
  parentSegments: readonly string[];
  parent: string;
  parentIdentity: { dev: bigint; ino: bigint };
  destination: string;
  temporaryIdentity: BigIntFileIdentity;
  expectedContent: Buffer;
}): Promise<void> {
  let publishedHandle;
  try {
    await requireUnchangedPublicationParent(input);
    publishedHandle = await open(
      input.destination,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const beforeRead = await publishedHandle.stat({ bigint: true });
    if (
      !beforeRead.isFile() ||
      !sameFileIdentity(beforeRead, input.temporaryIdentity)
    ) {
      throw storageError(
        "Project-local publication destination identity changed during commit",
        input.destination,
      );
    }
    const content = await publishedHandle.readFile();
    const afterRead = await publishedHandle.stat({ bigint: true });
    if (
      !sameFileIdentity(beforeRead, afterRead) ||
      !content.equals(input.expectedContent)
    ) {
      throw storageError(
        "Project-local publication destination bytes changed during commit",
        input.destination,
      );
    }
    const afterPath = await lstat(input.destination, { bigint: true });
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameFileIdentity(afterPath, afterRead)
    ) {
      throw storageError(
        "Project-local publication destination changed during verification",
        input.destination,
      );
    }
    await requireUnchangedPublicationParent(input);
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw storageError(
      "Project-local publication destination verification failed",
      input.destination,
      error,
    );
  } finally {
    await publishedHandle?.close();
  }
}

async function requireUnchangedPublicationParent(input: {
  projectRoot: string;
  parentSegments: readonly string[];
  parent: string;
  parentIdentity: { dev: bigint; ino: bigint };
}): Promise<void> {
  const verifiedParent = await requireProjectLocalDirectory(
    input.projectRoot,
    input.parentSegments,
  );
  const currentParent = await lstat(input.parent, { bigint: true });
  if (
    verifiedParent !== input.parent ||
    currentParent.dev !== input.parentIdentity.dev ||
    currentParent.ino !== input.parentIdentity.ino
  ) {
    throw storageError(
      "Project-local publication parent changed during verification",
      input.parent,
    );
  }
}

async function removeCapturedPublication(input: {
  parent: string;
  parentIdentity: { dev: bigint; ino: bigint };
  destination: string;
  temporaryIdentity: BigIntFileIdentity;
  durable: boolean;
}): Promise<void> {
  const currentParent = await lstat(input.parent, {
    bigint: true,
  }).catch(() => undefined);
  if (
    currentParent === undefined ||
    currentParent.isSymbolicLink() ||
    !currentParent.isDirectory() ||
    currentParent.dev !== input.parentIdentity.dev ||
    currentParent.ino !== input.parentIdentity.ino
  ) {
    return;
  }
  const currentDestination = await lstat(input.destination, {
    bigint: true,
  }).catch(() => undefined);
  if (
    currentDestination === undefined ||
    currentDestination.isSymbolicLink() ||
    !currentDestination.isFile() ||
    currentDestination.dev !== input.temporaryIdentity.dev ||
    currentDestination.ino !== input.temporaryIdentity.ino
  ) {
    return;
  }
  await unlink(input.destination).catch(() => undefined);
  if (input.durable) {
    await syncDirectoryWhereSupported(input.parent);
  }
}

async function verifyPublicationCommitState(input: {
  projectRoot: string;
  parentSegments: readonly string[];
  parent: string;
  parentIdentity: { dev: bigint; ino: bigint };
  temporaryPath: string;
  temporaryIdentity: BigIntFileIdentity;
  destination: string;
}): Promise<void> {
  try {
    await requireUnchangedPublicationParent(input);
    const currentTemporary = await lstat(input.temporaryPath, {
      bigint: true,
    });
    if (
      currentTemporary.isSymbolicLink() ||
      !currentTemporary.isFile() ||
      !sameFileIdentity(currentTemporary, input.temporaryIdentity)
    ) {
      throw storageError(
        "Project-local publication temporary artifact changed during verification",
        input.temporaryPath,
      );
    }
    try {
      await lstat(input.destination);
      throw storageError(
        "Project-local publication destination already exists",
        input.destination,
      );
    } catch (error: unknown) {
      if (error instanceof AiQaError) throw error;
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw storageError(
      "Project-local publication commit state verification failed",
      input.destination,
      error,
    );
  }
}

const removalClaimPrefix = ".ai-qa-removal-claim-";
const removalClaimEntry = "entry";

interface ProjectLocalRemovalInput {
  projectRoot: string;
  segments: readonly string[];
  expected: "file" | "directory";
  hooks?: ProjectLocalRemovalHooks;
}

interface ProjectLocalRemovalSpec {
  segments: readonly string[];
  expected: "file" | "directory";
}

interface ProjectLocalRemovalIdentity {
  dev: bigint;
  ino: bigint;
}

type InspectedProjectLocalRemoval =
  | {
      state: "missing";
      spec: ProjectLocalRemovalSpec;
      path: string;
      relativePath: string;
    }
  | {
      state: "present";
      spec: ProjectLocalRemovalSpec;
      path: string;
      relativePath: string;
      entryKind: "file" | "directory" | "symlink";
      identity: ProjectLocalRemovalIdentity;
    };

export async function prepareProjectLocalRemoval(
  input: ProjectLocalRemovalInput,
): Promise<PreparedProjectLocalRemoval> {
  const spec: ProjectLocalRemovalSpec = {
    segments: [...input.segments],
    expected: input.expected,
  };
  const afterFinalVerification = input.hooks?.afterFinalVerification;
  const beforeClaim = input.hooks?.beforeClaim;
  const afterClaim = input.hooks?.afterClaim;
  validateSegments(spec.segments);
  const projectRoot = await realpath(input.projectRoot);
  await assertNoRetainedRemovalClaim(projectRoot);
  const inspected = await inspectProjectLocalRemoval(projectRoot, spec);
  return {
    relativePath: inspected.relativePath,
    remove: () =>
      removePreparedProjectLocalEntry(
        projectRoot,
        inspected,
        afterFinalVerification,
        beforeClaim,
        afterClaim,
      ),
  };
}

export async function prepareProjectLocalClaimedFileRemoval(
  input: ProjectLocalClaimedFileRemovalInput,
): Promise<PreparedProjectLocalRemoval> {
  validateSegments(input.segments);
  validateSegments(input.claimDirectorySegments);
  const projectRoot = await realpath(input.projectRoot);
  const spec: ProjectLocalRemovalSpec = {
    segments: [...input.segments],
    expected: "file",
  };
  const preparedSource = await inspectProjectLocalRemoval(projectRoot, spec);
  const preparedClaim = await inspectDeterministicFileClaim(
    projectRoot,
    input.claimDirectorySegments,
  );
  assertValidDeterministicClaimState(
    preparedSource,
    preparedClaim,
    input.claimDirectorySegments,
  );
  if (preparedClaim.state === "populated") {
    await input.verifyClaimedFile(preparedClaim.path);
  }
  return {
    relativePath: preparedSource.relativePath,
    remove: () =>
      removePreparedClaimedFile(
        projectRoot,
        spec,
        preparedSource,
        input.claimDirectorySegments,
        input.verifyClaimedFile,
        input.hooks,
      ),
  };
}

type InspectedDeterministicFileClaim =
  | { state: "missing"; directory: string }
  | { state: "empty"; directory: string }
  | {
      state: "populated";
      directory: string;
      path: string;
      identity: ProjectLocalRemovalIdentity;
    };

async function inspectDeterministicFileClaim(
  projectRoot: string,
  claimDirectorySegments: readonly string[],
): Promise<InspectedDeterministicFileClaim> {
  const claimSpec: ProjectLocalRemovalSpec = {
    segments: claimDirectorySegments,
    expected: "directory",
  };
  const claim = await inspectProjectLocalRemoval(projectRoot, claimSpec);
  if (claim.state === "missing") {
    return { state: "missing", directory: claim.path };
  }
  const recoveryPath = `${claimDirectorySegments.join("/")}/${removalClaimEntry}`;
  if (claim.entryKind !== "directory") {
    throw recoveryRequiredError(
      "Evidence deletion claim is not a real directory",
      recoveryPath,
    );
  }
  const entries = await readdir(claim.path);
  if (entries.length === 0) {
    return { state: "empty", directory: claim.path };
  }
  if (entries.length !== 1 || entries[0] !== removalClaimEntry) {
    throw recoveryRequiredError(
      "Evidence deletion claim contains unexpected entries",
      recoveryPath,
    );
  }
  const path = resolve(claim.path, removalClaimEntry);
  const stats = await lstat(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw recoveryRequiredError(
      "Evidence deletion claim is not a regular file",
      recoveryPath,
    );
  }
  return {
    state: "populated",
    directory: claim.path,
    path,
    identity: { dev: stats.dev, ino: stats.ino },
  };
}

function assertValidDeterministicClaimState(
  source: InspectedProjectLocalRemoval,
  claim: InspectedDeterministicFileClaim,
  claimDirectorySegments: readonly string[],
): void {
  if (source.state === "present" && claim.state === "populated") {
    throw recoveryRequiredError(
      "Evidence source and deletion claim are both present",
      `${claimDirectorySegments.join("/")}/${removalClaimEntry}`,
    );
  }
}

async function removePreparedClaimedFile(
  projectRoot: string,
  spec: ProjectLocalRemovalSpec,
  preparedSource: InspectedProjectLocalRemoval,
  claimDirectorySegments: readonly string[],
  verifyClaimedFile: (path: string) => Promise<void>,
  hooks?: ProjectLocalRemovalHooks,
): Promise<boolean> {
  const source = await inspectProjectLocalRemoval(projectRoot, spec);
  let claim = await inspectDeterministicFileClaim(
    projectRoot,
    claimDirectorySegments,
  );
  assertValidDeterministicClaimState(source, claim, claimDirectorySegments);
  if (claim.state === "populated") {
    await verifyClaimedFile(claim.path);
    await hooks?.beforeClaim?.({ path: claim.path });
    await hooks?.beforeUnlink?.({ path: claim.path });
    await unlink(claim.path);
    await syncDirectoryWhereSupported(claim.directory);
    await hooks?.afterClaimUnlinkDurable?.({ path: claim.path });
    await removeDeterministicClaimDirectories(claim.directory);
    return true;
  }
  if (claim.state === "empty") {
    await removeDeterministicClaimDirectories(claim.directory);
    if (source.state === "missing") return true;
    claim = { state: "missing", directory: claim.directory };
  }
  if (source.state === "missing") return false;
  if (
    preparedSource.state !== "present" ||
    source.identity.dev !== preparedSource.identity.dev ||
    source.identity.ino !== preparedSource.identity.ino ||
    source.entryKind !== preparedSource.entryKind
  ) {
    throw storageError(
      "Project-local removal target changed during verification",
      source.path,
    );
  }
  await hooks?.afterFinalVerification?.({ path: source.path });
  const claimDirectory = await ensureProjectLocalDirectoryDurable(
    projectRoot,
    claimDirectorySegments,
  );
  await hooks?.afterClaimDirectoryDurable?.({ path: claimDirectory });
  const claimedPath = resolve(claimDirectory, removalClaimEntry);
  const recoveryPath = `${claimDirectorySegments.join("/")}/${removalClaimEntry}`;
  await hooks?.beforeClaim?.({ path: source.path });
  try {
    await rename(source.path, claimedPath);
    await syncDirectoryWhereSupported(dirname(source.path));
    await syncDirectoryWhereSupported(claimDirectory);
    await hooks?.afterClaimRenameDurable?.({ path: claimedPath });
    await hooks?.afterClaim?.({ path: claimedPath, recoveryPath });
    const claimed = await inspectDeterministicFileClaim(
      projectRoot,
      claimDirectorySegments,
    );
    if (
      claimed.state !== "populated" ||
      claimed.identity.dev !== source.identity.dev ||
      claimed.identity.ino !== source.identity.ino
    ) {
      throw storageError(
        "Evidence deletion claim does not match the prepared source",
        claimedPath,
      );
    }
    await verifyClaimedFile(claimed.path);
    await hooks?.beforeUnlink?.({ path: claimed.path });
    await unlink(claimed.path);
    await syncDirectoryWhereSupported(claimDirectory);
    await hooks?.afterClaimUnlinkDurable?.({ path: claimed.path });
    await removeDeterministicClaimDirectories(claimDirectory);
    return true;
  } catch (error: unknown) {
    throw recoveryRequiredError(
      "Evidence deletion requires recovery after the source was claimed",
      recoveryPath,
      error,
    );
  }
}

async function removeDeterministicClaimDirectories(
  claimDirectory: string,
): Promise<void> {
  const claimsDirectory = dirname(claimDirectory);
  await removeEmptyClaimDirectory(claimDirectory);
  await syncDirectoryWhereSupported(claimsDirectory);
  try {
    await rmdir(claimsDirectory);
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) {
      throw error;
    }
    return;
  }
  await syncDirectoryWhereSupported(dirname(claimsDirectory));
}

async function inspectProjectLocalRemoval(
  projectRoot: string,
  spec: ProjectLocalRemovalSpec,
): Promise<InspectedProjectLocalRemoval> {
  const path = resolve(projectRoot, ...spec.segments);
  const relativePath = spec.segments.join("/");
  let current = projectRoot;
  for (const segment of spec.segments.slice(0, -1)) {
    current = resolve(current, segment);
    let stats;
    try {
      stats = await lstat(current);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (await realpath(current)) !== current
      ) {
        throw storageError(
          "Project-local removal ancestor is not a real directory",
          current,
        );
      }
    } catch (error: unknown) {
      if (error instanceof AiQaError) throw error;
      if (isNodeError(error, "ENOENT")) {
        return { state: "missing", spec, path, relativePath };
      }
      throw storageError(
        "Project-local removal ancestor inspection failed",
        current,
        error,
      );
    }
  }

  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return { state: "missing", spec, path, relativePath };
    }
    throw storageError(
      "Project-local removal target inspection failed",
      path,
      error,
    );
  }
  const entryKind = stats.isSymbolicLink()
    ? "symlink"
    : stats.isFile()
      ? "file"
      : stats.isDirectory()
        ? "directory"
        : undefined;
  if (
    entryKind === undefined ||
    (entryKind !== "symlink" && entryKind !== spec.expected)
  ) {
    throw storageError(
      "Project-local removal target has an invalid type",
      path,
    );
  }
  return {
    state: "present",
    spec,
    path,
    relativePath,
    entryKind,
    identity: { dev: stats.dev, ino: stats.ino },
  };
}

async function removePreparedProjectLocalEntry(
  projectRoot: string,
  prepared: InspectedProjectLocalRemoval,
  afterFinalVerification?: ProjectLocalRemovalHooks["afterFinalVerification"],
  beforeClaim?: ProjectLocalRemovalHooks["beforeClaim"],
  afterClaim?: ProjectLocalRemovalHooks["afterClaim"],
): Promise<boolean> {
  if (prepared.state === "missing") return false;
  const current = await inspectProjectLocalRemoval(projectRoot, prepared.spec);
  if (current.state === "missing") return false;
  if (
    current.identity.dev !== prepared.identity.dev ||
    current.identity.ino !== prepared.identity.ino ||
    current.entryKind !== prepared.entryKind
  ) {
    throw storageError(
      "Project-local removal target changed during verification",
      prepared.path,
    );
  }
  await afterFinalVerification?.({ path: prepared.path });

  const claimDirectory = await createRemovalClaimDirectory(projectRoot);
  const claimedPath = resolve(claimDirectory, removalClaimEntry);
  const recoveryPath = `${basename(claimDirectory)}/${removalClaimEntry}`;
  try {
    await beforeClaim?.({ path: prepared.path });
    await rename(prepared.path, claimedPath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      try {
        await removeEmptyClaimDirectory(claimDirectory);
      } catch (cleanupError: unknown) {
        throw await removalClaimFailureError(
          projectRoot,
          claimDirectory,
          "Project-local removal claim cleanup failed",
          cleanupError,
        );
      }
      return false;
    }
    try {
      await removeEmptyClaimDirectory(claimDirectory);
    } catch (cleanupError: unknown) {
      throw await removalClaimFailureError(
        projectRoot,
        claimDirectory,
        "Project-local removal claim cleanup failed",
        cleanupError,
      );
    }
    throw storageError(
      "Project-local removal target could not be claimed",
      prepared.path,
      error,
    );
  }

  try {
    await afterClaim?.({ path: claimedPath, recoveryPath });
    const claimed = await inspectClaimedProjectLocalRemoval(claimedPath);
    if (
      claimed.identity.dev !== prepared.identity.dev ||
      claimed.identity.ino !== prepared.identity.ino ||
      claimed.entryKind !== prepared.entryKind
    ) {
      throw storageError(
        "Project-local removal claim does not match the prepared target",
        claimedPath,
      );
    }

    if (claimed.entryKind === "directory") {
      await rm(claimedPath, { recursive: true });
    } else {
      await unlink(claimedPath);
    }
    await removeEmptyClaimDirectory(claimDirectory);
    return true;
  } catch (error: unknown) {
    throw await removalClaimFailureError(
      projectRoot,
      claimDirectory,
      "Project-local removal failed after the target was claimed",
      error,
    );
  }
}

async function assertNoRetainedRemovalClaim(
  projectRoot: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(projectRoot);
  } catch (error: unknown) {
    throw storageError(
      "Project-local removal recovery scan failed",
      projectRoot,
      error,
    );
  }
  const retainedClaims = entries
    .filter(
      (entry) =>
        entry.startsWith(removalClaimPrefix) &&
        entry.length > removalClaimPrefix.length,
    )
    .sort();
  for (const retainedClaim of retainedClaims) {
    const recoveryPath = await retainedClaimRecoveryPath(
      projectRoot,
      retainedClaim,
    );
    if (recoveryPath !== undefined) {
      throw recoveryRequiredError(
        "Project-local removal recovery is required before another clear",
        recoveryPath,
      );
    }
  }
}

async function retainedClaimRecoveryPath(
  projectRoot: string,
  retainedClaim: string,
): Promise<string | undefined> {
  const claimDirectory = resolve(projectRoot, retainedClaim);
  let stats;
  try {
    stats = await lstat(claimDirectory);
  } catch (error: unknown) {
    return isNodeError(error, "ENOENT") ? undefined : retainedClaim;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return retainedClaim;
  try {
    if ((await realpath(claimDirectory)) !== claimDirectory) {
      return retainedClaim;
    }
  } catch {
    return retainedClaim;
  }
  try {
    await lstat(resolve(claimDirectory, removalClaimEntry));
    return `${retainedClaim}/${removalClaimEntry}`;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return retainedClaim;
    }
    return retainedClaim;
  }
}

async function removalClaimFailureError(
  projectRoot: string,
  claimDirectory: string,
  message: string,
  cause: unknown,
): Promise<AiQaError> {
  const claimPath = basename(claimDirectory);
  const recoveryPath = await retainedClaimRecoveryPath(projectRoot, claimPath);
  if (recoveryPath === undefined) {
    return new AiQaError(
      "storage.integrity_error",
      "Project-local removal claim disappeared after it was claimed",
      {
        claimPath,
        cause: toErrorCause(cause),
      },
    );
  }
  return recoveryRequiredError(message, recoveryPath, cause);
}

async function createRemovalClaimDirectory(
  projectRoot: string,
): Promise<string> {
  let claimDirectory: string;
  try {
    claimDirectory = await mkdtemp(resolve(projectRoot, removalClaimPrefix));
  } catch (error: unknown) {
    throw storageError(
      "Project-local removal claim creation failed",
      projectRoot,
      error,
    );
  }
  try {
    const stats = await lstat(claimDirectory);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      (await realpath(claimDirectory)) !== claimDirectory
    ) {
      throw storageError(
        "Project-local removal claim is not a real directory",
        claimDirectory,
      );
    }
  } catch (error: unknown) {
    throw await removalClaimFailureError(
      projectRoot,
      claimDirectory,
      "Project-local removal claim verification failed",
      error,
    );
  }
  return claimDirectory;
}

async function inspectClaimedProjectLocalRemoval(claimedPath: string): Promise<{
  entryKind: "file" | "directory" | "symlink";
  identity: ProjectLocalRemovalIdentity;
}> {
  try {
    const stats = await lstat(claimedPath, { bigint: true });
    const entryKind = stats.isSymbolicLink()
      ? "symlink"
      : stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "directory"
          : undefined;
    if (entryKind === undefined) {
      throw storageError(
        "Project-local removal claim has an invalid type",
        claimedPath,
      );
    }
    return {
      entryKind,
      identity: { dev: stats.dev, ino: stats.ino },
    };
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw storageError(
      "Project-local removal claim inspection failed",
      claimedPath,
      error,
    );
  }
}

async function removeEmptyClaimDirectory(
  claimDirectory: string,
): Promise<void> {
  try {
    await rmdir(claimDirectory);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

export async function inspectOptionalProjectLocalRegularFile(
  projectRoot: string,
  segments: readonly string[],
  hooks?: OptionalProjectLocalInspectionHooks,
): Promise<OptionalProjectLocalFile> {
  validateSegments(segments);
  const canonicalRoot = await realpath(projectRoot);
  const path = resolve(canonicalRoot, ...segments);
  let current = canonicalRoot;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return { path, state: "missing" };
      throw storageError(
        "Project-local storage directory verification failed",
        current,
        error,
      );
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      (await realpath(current)) !== current
    ) {
      throw storageError(
        "Project-local storage ancestor is not a real directory",
        current,
      );
    }
  }
  let pathStats;
  try {
    pathStats = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return { path, state: "missing" };
    throw storageError(
      "Project-local artifact verification failed",
      path,
      error,
    );
  }
  if (
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    (await realpath(path)) !== path
  ) {
    throw storageError(
      "Project-local artifact is not a real regular file",
      path,
    );
  }
  await hooks?.afterPathIdentity?.({ path });
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const beforeRead = await handle.stat({ bigint: true });
    if (
      !beforeRead.isFile() ||
      beforeRead.dev !== pathStats.dev ||
      beforeRead.ino !== pathStats.ino
    ) {
      throw storageError(
        "Project-local artifact changed during verification",
        path,
      );
    }
    const content = await handle.readFile({ encoding: "utf8" });
    await hooks?.afterHandleRead?.({ path });
    const afterRead = await handle.stat({ bigint: true });
    if (!sameFileIdentity(beforeRead, afterRead)) {
      throw storageError(
        "Project-local artifact changed while being read",
        path,
      );
    }
    const afterPath = await lstat(path, { bigint: true });
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.dev !== afterRead.dev ||
      afterPath.ino !== afterRead.ino ||
      (await realpath(path)) !== path
    ) {
      throw storageError(
        "Project-local artifact changed during verification",
        path,
      );
    }
    return {
      path,
      state: "regular",
      content,
      stats: {
        dev: afterRead.dev,
        ino: afterRead.ino,
        size: afterRead.size,
        mtimeNs: afterRead.mtimeNs,
      },
    };
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw storageError(
      "Project-local artifact verification failed",
      path,
      error,
    );
  } finally {
    await handle?.close();
  }
}

interface BigIntFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

function sameFileIdentity(
  left: BigIntFileIdentity,
  right: BigIntFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

export async function requireProjectLocalRegularFile(
  projectRoot: string,
  segments: readonly string[],
): Promise<string> {
  validateSegments(segments);
  const parent = await requireProjectLocalDirectory(
    projectRoot,
    segments.slice(0, -1),
  );
  const path = resolve(parent, segments.at(-1)!);
  try {
    const stats = await lstat(path);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      (await realpath(path)) !== path
    ) {
      throw storageError(
        "Project-local artifact is not a real regular file",
        path,
      );
    }
    return path;
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw storageError(
      "Project-local artifact verification failed",
      path,
      error,
    );
  }
}

function storageError(
  message: string,
  path?: string,
  cause?: unknown,
  details: Readonly<Record<string, unknown>> = {},
): AiQaError {
  return new AiQaError("storage.integrity_error", message, {
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause: toErrorCause(cause) }),
    ...details,
  });
}

function recoveryRequiredError(
  message: string,
  recoveryPath: string,
  cause?: unknown,
): AiQaError {
  return new AiQaError("storage.recovery_required", message, {
    recoveryPath,
    ...(cause === undefined ? {} : { cause: toErrorCause(cause) }),
  });
}
