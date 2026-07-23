import lockfile from "proper-lockfile";
import { AiQaError } from "../errors.js";

export type LockProfile = "hot" | "cold";

export interface LockSignal {
  compromised(): boolean;
}

const PROFILES = {
  hot: {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 1_000 },
    stale: 2_000,
  },
  cold: {
    retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
  },
} as const;

export async function withLock<T>(
  path: string,
  profile: LockProfile,
  callback: (signal: LockSignal) => Promise<T>,
): Promise<T> {
  let compromised = false;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(path, {
      realpath: false,
      ...PROFILES[profile],
      onCompromised: () => {
        compromised = true;
      },
    });
  } catch (error: unknown) {
    if (isNodeError(error, "ELOCKED")) {
      throw new AiQaError(
        "storage.lock_contended",
        "Another ai-qa process holds this lock",
        { path },
        { retryable: true },
      );
    }
    throw error;
  }

  const signal: LockSignal = { compromised: () => compromised };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await callback(signal) };
  } catch (error: unknown) {
    outcome = { ok: false, error };
  }

  try {
    await release();
  } catch (error: unknown) {
    if (!compromised) throw error;
  }

  if (compromised) {
    throw new AiQaError(
      "storage.lock_compromised",
      "The lock was compromised while the operation ran; its outcome is unknown",
      { path },
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export function assertNotCompromised(signal: LockSignal, path: string): void {
  if (signal.compromised()) {
    throw new AiQaError(
      "storage.lock_compromised",
      "The lock was compromised before the write could commit",
      { path },
    );
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
