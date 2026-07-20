import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import { resolve } from "node:path";
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

interface ProjectLocalRemovalInput {
  projectRoot: string;
  segments: readonly string[];
  expected: "file" | "directory";
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
  validateSegments(spec.segments);
  const projectRoot = await realpath(input.projectRoot);
  const inspected = await inspectProjectLocalRemoval(projectRoot, spec);
  return {
    relativePath: inspected.relativePath,
    remove: () => removePreparedProjectLocalEntry(projectRoot, inspected),
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
  try {
    if (current.entryKind === "directory") {
      await rm(current.path, { recursive: true });
    } else {
      await unlink(current.path);
    }
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return false;
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
): AiQaError {
  return new AiQaError("storage.integrity_error", message, {
    ...(path === undefined ? {} : { path }),
    ...(causeCode === undefined ? {} : { causeCode }),
  });
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
