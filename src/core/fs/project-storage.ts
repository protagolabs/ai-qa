import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
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

export async function inspectOptionalProjectLocalRegularFile(
  projectRoot: string,
  segments: readonly string[],
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
  let stats;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return { path, state: "missing" };
    throw storageError(
      "Project-local artifact verification failed",
      path,
      nodeErrorCode(error),
    );
  }
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
  return {
    path,
    state: "regular",
    content: await readFile(path, "utf8"),
    stats: {
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeNs: stats.mtimeNs,
    },
  };
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
