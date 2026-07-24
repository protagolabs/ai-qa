import { isErrnoCode } from "./node-errors.js";

export interface ErrorIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export interface ErrorCause {
  readonly code: string;
  readonly message: string;
}

function isErrorCause(value: unknown): value is ErrorCause {
  return (
    value !== null &&
    typeof value === "object" &&
    "code" in value &&
    typeof (value as { code?: unknown }).code === "string" &&
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

interface FilesystemErrorOrigin {
  readonly code: string;
  readonly syscall?: string;
}

interface CodedErrorOrigin extends FilesystemErrorOrigin {
  readonly message: string;
}

function extractCodedErrorOrigin(error: unknown): CodedErrorOrigin | undefined {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    typeof (error as NodeJS.ErrnoException).code !== "string"
  ) {
    return undefined;
  }

  const filesystemError = error as NodeJS.ErrnoException & { code: string };
  return {
    code: filesystemError.code,
    message: filesystemError.message,
    ...(typeof filesystemError.syscall === "string"
      ? { syscall: filesystemError.syscall }
      : {}),
  };
}

function extractFilesystemErrorOrigin(
  error: unknown,
): CodedErrorOrigin | undefined {
  const origin = extractCodedErrorOrigin(error);
  return origin !== undefined && isErrnoCode(origin.code) ? origin : undefined;
}

function toFilesystemErrorCause({
  code,
  syscall,
}: FilesystemErrorOrigin): ErrorCause {
  return {
    code,
    message:
      syscall === undefined
        ? `The filesystem reported ${code}`
        : `The filesystem reported ${code} during ${syscall}`,
  };
}

export function extractErrorCause(error: unknown): ErrorCause | undefined {
  if (error instanceof AiQaError) {
    const cause = error.details.cause;
    return isErrorCause(cause)
      ? { code: cause.code, message: cause.message }
      : undefined;
  }
  const codedError = extractCodedErrorOrigin(error);
  if (codedError === undefined) return undefined;
  return isErrnoCode(codedError.code)
    ? toFilesystemErrorCause(codedError)
    : { code: codedError.code, message: codedError.message };
}

export function errorCauseCode(error: unknown): string | undefined {
  return extractErrorCause(error)?.code;
}

export class AiQaError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  readonly issues: readonly ErrorIssue[] | undefined;

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options: { retryable?: boolean; issues?: readonly ErrorIssue[] } = {},
  ) {
    super(message);
    this.name = "AiQaError";
    this.code = code;
    this.details = details;
    this.retryable = options.retryable === true;
    this.issues = options.issues;
  }
}

export function toErrorCause(error: unknown): ErrorCause {
  if (error instanceof AiQaError) {
    return { code: error.code, message: error.message };
  }
  const codedError = extractCodedErrorOrigin(error);
  if (codedError !== undefined) {
    return isErrnoCode(codedError.code)
      ? toFilesystemErrorCause(codedError)
      : { code: codedError.code, message: codedError.message };
  }
  if (error instanceof SyntaxError) {
    return { code: "json.parse_error", message: error.message };
  }
  return {
    code: "parse_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The one shape a filesystem.operation_failed error takes, wherever it is
 * produced. The origin is summarized from code and syscall only; the raw
 * message may embed project paths and must not reach the error contract.
 */
export function toFilesystemOperationFailure(error: unknown): AiQaError {
  const code = errorCauseCode(error) ?? toErrorCause(error).code;
  const syscall = extractFilesystemErrorOrigin(error)?.syscall;
  return new AiQaError(
    "filesystem.operation_failed",
    "A filesystem operation failed",
    {
      cause: toFilesystemErrorCause({
        code,
        ...(syscall === undefined ? {} : { syscall }),
      }),
      ...(syscall === undefined ? {} : { syscall }),
    },
  );
}

export function normalizeUnknownError(error: unknown): AiQaError {
  if (error instanceof AiQaError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  ) {
    return toFilesystemOperationFailure(error);
  }
  return new AiQaError(
    "internal.unexpected_error",
    "An unexpected internal error occurred",
  );
}
