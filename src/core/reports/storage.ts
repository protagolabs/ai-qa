import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { AiQaError } from "../errors.js";
import { withLock, type LockSignal } from "../fs/locking.js";
import { runGroupIdSchema } from "../run-groups/schema.js";
import { runIdSchema } from "../runs/schema.js";

type RunReportFilename =
  "report.json" | "report.md" | "recording.jsonl" | "recording.json";

type ReportSubject =
  { kind: "run"; id: string } | { kind: "run-group"; id: string };

export async function resolveRunReportDirectory(input: {
  projectRoot: string;
  runId: string;
  create: boolean;
}): Promise<string> {
  const runId = runIdSchema.parse(input.runId);
  return resolveReportDirectory({
    projectRoot: input.projectRoot,
    subject: { kind: "run", id: runId },
    create: input.create,
  });
}

export async function resolveGroupReportDirectory(input: {
  projectRoot: string;
  runGroupId: string;
  create: boolean;
}): Promise<string> {
  const runGroupId = runGroupIdSchema.parse(input.runGroupId);
  return resolveReportDirectory({
    projectRoot: input.projectRoot,
    subject: { kind: "run-group", id: runGroupId },
    create: input.create,
  });
}

async function resolveReportDirectory(input: {
  projectRoot: string;
  subject: ReportSubject;
  create: boolean;
}): Promise<string> {
  const canonicalProjectRoot = await realpath(input.projectRoot);
  let directory = canonicalProjectRoot;
  for (const segment of [
    ".ai-qa",
    "reports",
    input.subject.kind === "run" ? "runs" : "groups",
    input.subject.id,
  ]) {
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
          reportDetails(input.subject),
        );
      }
      if (error instanceof AiQaError && error.code === "report.not_generated") {
        throw error;
      }
      throw new AiQaError(
        "report.storage_integrity_error",
        "Report storage must stay in real project-local directories",
        { ...reportDetails(input.subject), path: directory },
      );
    }
  }
  return directory;
}

export async function requireGroupReportRegularFile(input: {
  directory: string;
  filename: RunReportFilename;
  runGroupId: string;
  missingCode: "report.not_generated" | "recording.not_found";
}): Promise<string> {
  const runGroupId = runGroupIdSchema.parse(input.runGroupId);
  return requireReportRegularFile({
    directory: input.directory,
    filename: input.filename,
    subject: { kind: "run-group", id: runGroupId },
    missingCode: input.missingCode,
  });
}

export async function requireRunReportRegularFile(input: {
  directory: string;
  filename: RunReportFilename;
  runId: string;
  missingCode: "report.not_generated" | "recording.not_found";
}): Promise<string> {
  const runId = runIdSchema.parse(input.runId);
  return requireReportRegularFile({
    directory: input.directory,
    filename: input.filename,
    subject: { kind: "run", id: runId },
    missingCode: input.missingCode,
  });
}

async function requireReportRegularFile(input: {
  directory: string;
  filename: RunReportFilename;
  subject: ReportSubject;
  missingCode: "report.not_generated" | "recording.not_found";
}): Promise<string> {
  const path = resolve(input.directory, input.filename);
  const projectRelativePath = `.ai-qa/reports/${input.subject.kind === "run" ? "runs" : "groups"}/${input.subject.id}/${input.filename}`;
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
        { ...reportDetails(input.subject), path: projectRelativePath },
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
        { ...reportDetails(input.subject), path: projectRelativePath },
      );
    }
    throw new AiQaError(
      "report.storage_integrity_error",
      "Report artifact integrity verification failed",
      { ...reportDetails(input.subject), path: projectRelativePath },
    );
  }
  return path;
}

export async function withRunReportLock<T>(
  directory: string,
  operation: (signal: LockSignal) => Promise<T>,
): Promise<T> {
  return withLock(directory, "cold", operation);
}

export const withGroupReportLock = withRunReportLock;

function reportDetails(
  subject: ReportSubject,
): { runId: string } | { runGroupId: string } {
  return subject.kind === "run"
    ? { runId: subject.id }
    : { runGroupId: subject.id };
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
