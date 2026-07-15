import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { AiQaError } from "../errors.js";
import { runIdSchema } from "../runs/schema.js";

type RunReportFilename =
  "report.json" | "report.md" | "recording.jsonl" | "recording.json";

export async function resolveRunReportDirectory(input: {
  projectRoot: string;
  runId: string;
  create: boolean;
}): Promise<string> {
  const runId = runIdSchema.parse(input.runId);
  const canonicalProjectRoot = await realpath(input.projectRoot);
  let directory = canonicalProjectRoot;
  for (const segment of [".ai-qa", "reports", "runs", runId]) {
    directory = resolve(directory, segment);
    if (input.create) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error: unknown) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
    }
    try {
      const stats = await lstat(directory);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (await realpath(directory)) !== directory
      ) {
        throw new Error("report storage ancestor is not a real directory");
      }
    } catch (error: unknown) {
      if (!input.create && isNodeError(error, "ENOENT")) {
        throw new AiQaError(
          "report.not_generated",
          "Configured project-local report output has not been generated",
          { runId },
        );
      }
      if (error instanceof AiQaError && error.code === "report.not_generated") {
        throw error;
      }
      throw new AiQaError(
        "report.storage_integrity_error",
        "Report storage must stay in real project-local directories",
        { runId, path: directory },
      );
    }
  }
  return directory;
}

export async function requireRunReportRegularFile(input: {
  directory: string;
  filename: RunReportFilename;
  runId: string;
  missingCode: "report.not_generated" | "recording.not_found";
}): Promise<string> {
  const runId = runIdSchema.parse(input.runId);
  const path = resolve(input.directory, input.filename);
  const projectRelativePath = `.ai-qa/reports/runs/${runId}/${input.filename}`;
  try {
    const stats = await lstat(path);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      (await realpath(path)) !== path
    ) {
      throw new AiQaError(
        "report.storage_integrity_error",
        "Report artifacts must be real project-local files",
        { runId, path: projectRelativePath },
      );
    }
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    if (isNodeError(error, "ENOENT")) {
      throw new AiQaError(
        input.missingCode,
        input.missingCode === "report.not_generated"
          ? "Configured project-local report output has not been generated"
          : "Run recording has not been generated",
        { runId, path: projectRelativePath },
      );
    }
    throw new AiQaError(
      "report.storage_integrity_error",
      "Report artifact integrity verification failed",
      { runId, path: projectRelativePath },
    );
  }
  return path;
}

export async function withRunReportLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(directory, {
    realpath: false,
    retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
