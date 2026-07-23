import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiQaError } from "../../src/core/errors.js";
import { atomicWriteFile } from "../../src/core/fs/atomic-write.js";
import { assertNotCompromised, withLock } from "../../src/core/fs/locking.js";

describe("withLock", () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-qa-lock-"));
    target = join(dir, "target.json");
    await writeFile(target, "{}\n", "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the callback and returns its result", async () => {
    await expect(
      withLock(target, "cold", () => Promise.resolve(7)),
    ).resolves.toBe(7);
  });

  it("maps exhausted contention to retryable storage.lock_contended", async () => {
    const release = await lockfile.lock(target, { realpath: false });
    try {
      const error = await withLock(target, "cold", () =>
        Promise.resolve(1),
      ).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(AiQaError);
      expect((error as AiQaError).code).toBe("storage.lock_contended");
      expect((error as AiQaError).retryable).toBe(true);
    } finally {
      await release();
    }
  }, 30_000);

  it("reports compromise as non-retryable after the callback settles", async () => {
    const order: string[] = [];
    const error = await withLock(target, "hot", async (signal) => {
      await rm(`${target}.lock`, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      order.push(signal.compromised() ? "saw-compromise" : "missed");
      order.push("settled");
      return 1;
    }).catch((thrown: unknown) => thrown);
    expect(order).toEqual(["saw-compromise", "settled"]);
    expect(error).toBeInstanceOf(AiQaError);
    expect((error as AiQaError).code).toBe("storage.lock_compromised");
    expect((error as AiQaError).retryable).toBe(false);
  }, 30_000);

  it("reports compromise even when the callback also rejects", async () => {
    const callbackError = new Error("callback failed after compromise");
    const error = await withLock(target, "hot", async (signal) => {
      await rm(`${target}.lock`, { recursive: true, force: true });
      const deadline = Date.now() + 5_000;
      while (!signal.compromised() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw callbackError;
    }).catch((thrown: unknown) => thrown);

    expect(error).not.toBe(callbackError);
    expect(error).toBeInstanceOf(AiQaError);
    expect((error as AiQaError).code).toBe("storage.lock_compromised");
    expect((error as AiQaError).retryable).toBe(false);
  }, 30_000);

  it("blocks a write after compromise is observed", async () => {
    const original = await readFile(target);
    const error = await withLock(target, "hot", async (signal) => {
      await rm(`${target}.lock`, { recursive: true, force: true });
      const deadline = Date.now() + 5_000;
      while (!signal.compromised() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertNotCompromised(signal, target);
      await writeFile(target, "stale write\n", "utf8");
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AiQaError);
    expect((error as AiQaError).code).toBe("storage.lock_compromised");
    await expect(readFile(target)).resolves.toEqual(original);
  }, 30_000);
});

describe("atomicWriteFile", () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-qa-atomic-write-"));
    target = join(dir, "target.json");
    await writeFile(target, Buffer.from([0, 1, 2, 3]));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves the target unchanged and cleans the temp file when preCommit throws", async () => {
    const original = await readFile(target);
    const error = new Error("compromised");

    await expect(
      atomicWriteFile(target, "replacement", {
        preCommit: () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);

    await expect(readFile(target)).resolves.toEqual(original);
    await expect(readdir(dir)).resolves.toEqual(["target.json"]);
  });
});
