export function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

// Matches POSIX errno identifiers (EACCES, EIO, E2BIG, ...) but not Node API
// error codes (ERR_*), which carry underscores.
const errnoCodePattern = /^E[A-Z0-9]{2,}$/;

export function isErrnoCode(code: string | undefined): code is string {
  return code !== undefined && errnoCodePattern.test(code);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
