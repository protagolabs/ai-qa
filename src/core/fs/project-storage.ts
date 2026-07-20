import { constants } from "node:fs";
import {
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
import { basename, resolve } from "node:path";
import { AiQaError } from "../errors.js";

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

async function walkDirectories(
  projectRoot: string,
  segments: readonly string[],
  create: boolean,
): Promise<string> {
  validateSegments(segments);
  let current = await realpath(projectRoot);
  for (const segment of segments) {
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
        nodeErrorCode(error),
      );
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

export function requireProjectLocalDirectory(
  projectRoot: string,
  segments: readonly string[],
): Promise<string> {
  return walkDirectories(projectRoot, segments, false);
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
  afterClaim?: (input: { path: string; recoveryPath: string }) => Promise<void>;
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
        afterClaim,
      ),
  };
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
        nodeErrorCode(error),
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
      nodeErrorCode(error),
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
      nodeErrorCode(error),
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
      nodeErrorCode(error),
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
    const causeCode = errorCauseCode(cause);
    return new AiQaError(
      "storage.integrity_error",
      "Project-local removal claim disappeared after it was claimed",
      {
        claimPath,
        ...(causeCode === undefined ? {} : { causeCode }),
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
      nodeErrorCode(error),
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
      nodeErrorCode(error),
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
        nodeErrorCode(error),
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
      nodeErrorCode(error),
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
      nodeErrorCode(error),
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
      nodeErrorCode(error),
    );
  }
}

function storageError(
  message: string,
  path?: string,
  causeCode?: string,
  details: Readonly<Record<string, unknown>> = {},
): AiQaError {
  return new AiQaError("storage.integrity_error", message, {
    ...(path === undefined ? {} : { path }),
    ...(causeCode === undefined ? {} : { causeCode }),
    ...details,
  });
}

function recoveryRequiredError(
  message: string,
  recoveryPath: string,
  cause?: unknown,
): AiQaError {
  const causeCode = errorCauseCode(cause);
  return new AiQaError("storage.recovery_required", message, {
    recoveryPath,
    ...(causeCode === undefined ? {} : { causeCode }),
  });
}

function errorCauseCode(error: unknown): string | undefined {
  return (
    nodeErrorCode(error) ??
    (error instanceof AiQaError ? error.code : undefined)
  );
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
