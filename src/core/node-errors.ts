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

// These errnos describe the shape of a path — a component that is not the
// directory or file it must be — which for project-local storage is damage,
// not an environmental condition. ENOENT is excluded because callers give
// missing paths their own meaning (not-found, empty index).
const shapeErrnoCodes = new Set(["ENOENT", "ENOTDIR", "EISDIR", "ELOOP"]);

export function isEnvironmentalErrnoCode(
  code: string | undefined,
): code is string {
  return isErrnoCode(code) && !shapeErrnoCodes.has(code);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
