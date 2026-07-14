export class AiQaError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AiQaError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeUnknownError(error: unknown): AiQaError {
  if (error instanceof AiQaError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  ) {
    const nodeError = error as NodeJS.ErrnoException;
    return new AiQaError(
      "filesystem.operation_failed",
      "A filesystem operation failed",
      {
        code: nodeError.code,
        ...(nodeError.syscall === undefined
          ? {}
          : { syscall: nodeError.syscall }),
      },
    );
  }
  return new AiQaError(
    "internal.unexpected_error",
    "An unexpected internal error occurred",
  );
}
