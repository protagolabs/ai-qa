import {
  access,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiQaError } from "../../src/core/errors.js";
import {
  ensureProjectLocalDirectory,
  inspectOptionalProjectLocalRegularFile,
  prepareProjectLocalRemoval,
  publishProjectLocalRegularFile,
  requireProjectLocalRegularFile,
  sweepStaleStaging,
} from "../../src/core/fs/project-storage.js";

describe("project-local storage", () => {
  it("sweeps only stale real staging directories directly inside the root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    const root = join(projectRoot, ".ai-qa", "runs");
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-storage-outside-"));
    await mkdir(root, { recursive: true });
    const stale = join(root, ".run-staging-stale");
    const threshold = join(root, ".run-staging-threshold");
    const fresh = join(root, ".run-staging-fresh");
    const file = join(root, ".run-staging-file");
    const link = join(root, ".run-staging-link");
    const differentPrefix = join(root, ".group-staging-stale");
    for (const directory of [stale, threshold, fresh, differentPrefix]) {
      await mkdir(directory);
    }
    await writeFile(file, "not a directory");
    await symlink(outside, link);
    const now = new Date("2026-07-17T00:00:00.000Z");
    const staleAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const thresholdAt = new Date(now.getTime() - 60 * 60 * 1000);
    await utimes(stale, staleAt, staleAt);
    await utimes(threshold, thresholdAt, thresholdAt);

    await expect(
      sweepStaleStaging(root, ".run-staging-", () => now),
    ).resolves.toEqual([".run-staging-stale"]);

    await expect(access(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(threshold)).resolves.toBeUndefined();
    await expect(access(fresh)).resolves.toBeUndefined();
    await expect(access(file)).resolves.toBeUndefined();
    await expect(access(link)).resolves.toBeUndefined();
    await expect(access(differentPrefix)).resolves.toBeUndefined();
    await expect(access(outside)).resolves.toBeUndefined();
  });

  it("rejects a symlinked .ai-qa ancestor before creating descendants", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-storage-outside-"));
    await symlink(outside, join(projectRoot, ".ai-qa"));

    await expect(
      ensureProjectLocalDirectory(projectRoot, [".ai-qa", "runs"]),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
  });

  it("rejects a symlinked file even when it resolves inside the project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    await writeFile(join(projectRoot, "real.yaml"), "schemaVersion: 1\n");
    await symlink(
      join(projectRoot, "real.yaml"),
      join(projectRoot, ".ai-qa", "config.yaml"),
    );

    await expect(
      requireProjectLocalRegularFile(projectRoot, [".ai-qa", "config.yaml"]),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
  });

  it("does not follow a file swapped to an outside symlink after path identity", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-storage-outside-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const destination = join(projectRoot, ".ai-qa", "config.yaml");
    const displaced = join(projectRoot, ".ai-qa", "displaced.yaml");
    const outsideFile = join(outside, "outside.yaml");
    await writeFile(destination, "inside bytes\n");
    await writeFile(outsideFile, "outside bytes\n");

    await expect(
      inspectOptionalProjectLocalRegularFile(
        projectRoot,
        [".ai-qa", "config.yaml"],
        {
          afterPathIdentity: async () => {
            await rename(destination, displaced);
            await symlink(outsideFile, destination);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });

    await expect(readFile(outsideFile, "utf8")).resolves.toBe(
      "outside bytes\n",
    );
  });

  it("rejects a pathname swapped away from the opened file after reading", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-storage-outside-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const destination = join(projectRoot, ".ai-qa", "config.yaml");
    const displaced = join(projectRoot, ".ai-qa", "displaced.yaml");
    const outsideFile = join(outside, "outside.yaml");
    await writeFile(destination, "inside bytes\n");
    await writeFile(outsideFile, "outside bytes\n");

    await expect(
      inspectOptionalProjectLocalRegularFile(
        projectRoot,
        [".ai-qa", "config.yaml"],
        {
          afterHandleRead: async () => {
            await rename(destination, displaced);
            await symlink(outsideFile, destination);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });

    await expect(readFile(displaced, "utf8")).resolves.toBe("inside bytes\n");
    await expect(readFile(outsideFile, "utf8")).resolves.toBe(
      "outside bytes\n",
    );
  });

  it("does not overwrite a replacement created at final publication verification", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const destination = join(projectRoot, ".ai-qa", "recovered.bin");

    await expect(
      publishProjectLocalRegularFile({
        projectRoot,
        segments: [".ai-qa", "recovered.bin"],
        content: Buffer.from("recovery bytes"),
        hooks: {
          afterFinalVerification: async () => {
            await writeFile(destination, "replacement bytes");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
    await expect(readFile(destination, "utf8")).resolves.toBe(
      "replacement bytes",
    );
    expect(
      (await readdir(join(projectRoot, ".ai-qa"))).filter((entry) =>
        entry.includes(".tmp"),
      ),
    ).toEqual([]);
  });

  it("removes only the regular file prepared for removal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const path = join(projectRoot, ".ai-qa", "config.yaml");
    await writeFile(path, "schemaVersion: 3\n");

    const prepared = await prepareProjectLocalRemoval({
      projectRoot,
      segments: [".ai-qa", "config.yaml"],
      expected: "file",
    });

    expect(prepared.relativePath).toBe(".ai-qa/config.yaml");
    await expect(prepared.remove()).resolves.toBe(true);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(projectRoot)).resolves.toEqual([".ai-qa"]);
  });

  it("does not remove an entry created after a missing target was prepared", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const path = join(projectRoot, ".ai-qa", "config.yaml");
    const prepared = await prepareProjectLocalRemoval({
      projectRoot,
      segments: [".ai-qa", "config.yaml"],
      expected: "file",
    });
    await writeFile(path, "created later\n");

    await expect(prepared.remove()).resolves.toBe(false);
    await expect(readFile(path, "utf8")).resolves.toBe("created later\n");
  });

  it("rejects a target replaced after preparation without removing the replacement", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const path = join(projectRoot, ".ai-qa", "config.yaml");
    const displaced = join(projectRoot, ".ai-qa", "displaced.yaml");
    await writeFile(path, "prepared bytes\n");
    const prepared = await prepareProjectLocalRemoval({
      projectRoot,
      segments: [".ai-qa", "config.yaml"],
      expected: "file",
    });
    await rename(path, displaced);
    await writeFile(path, "replacement bytes\n");

    await expect(prepared.remove()).rejects.toMatchObject({
      code: "storage.integrity_error",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("replacement bytes\n");
    await expect(readFile(displaced, "utf8")).resolves.toBe("prepared bytes\n");
  });

  it("preserves a target replaced after final verification in a project-local recovery claim", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const path = join(projectRoot, ".ai-qa", "config.yaml");
    const displaced = join(projectRoot, ".ai-qa", "displaced.yaml");
    await writeFile(path, "prepared bytes\n");
    const prepared = await prepareProjectLocalRemoval({
      projectRoot,
      segments: [".ai-qa", "config.yaml"],
      expected: "file",
      hooks: {
        afterFinalVerification: async () => {
          await rename(path, displaced);
          await writeFile(path, "replacement bytes\n");
        },
      },
    });

    let thrown: unknown;
    try {
      await prepared.remove();
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "storage.recovery_required" });
    expect(thrown).toBeInstanceOf(AiQaError);
    if (!(thrown instanceof AiQaError)) throw new Error("Expected AiQaError");
    const recoveryPath = thrown.details.recoveryPath;
    expect(typeof recoveryPath).toBe("string");
    if (typeof recoveryPath !== "string") {
      throw new Error("Expected a project-local recovery path");
    }
    await expect(
      readFile(join(projectRoot, recoveryPath), "utf8"),
    ).resolves.toBe("replacement bytes\n");
    await expect(readFile(displaced, "utf8")).resolves.toBe("prepared bytes\n");
  });

  it("cleans an empty recovery claim when the source disappears before it can be claimed", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const path = join(projectRoot, ".ai-qa", "config.yaml");
    await writeFile(path, "prepared bytes\n");
    const prepared = await prepareProjectLocalRemoval({
      projectRoot,
      segments: [".ai-qa", "config.yaml"],
      expected: "file",
      hooks: {
        afterFinalVerification: async () => {
          await unlink(path);
        },
      },
    });

    await expect(prepared.remove()).resolves.toBe(false);
    await expect(readdir(projectRoot)).resolves.toEqual([".ai-qa"]);
  });

  it("retains a claimed entry after a post-claim failure and blocks retry with its recovery path", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const path = join(projectRoot, ".ai-qa", "config.yaml");
    await writeFile(path, "prepared bytes\n");
    const prepared = await prepareProjectLocalRemoval({
      projectRoot,
      segments: [".ai-qa", "config.yaml"],
      expected: "file",
      hooks: {
        afterClaim: () =>
          Promise.reject(
            Object.assign(new Error("injected post-claim failure"), {
              code: "EIO",
            }),
          ),
      },
    });

    let firstError: unknown;
    try {
      await prepared.remove();
    } catch (error: unknown) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(AiQaError);
    if (!(firstError instanceof AiQaError)) {
      throw new Error("Expected AiQaError");
    }
    expect(firstError.code).toBe("storage.recovery_required");
    expect(firstError.details).toMatchObject({ causeCode: "EIO" });
    const recoveryPath = firstError.details.recoveryPath;
    expect(recoveryPath).toMatch(/^\.ai-qa-removal-claim-.+\/entry$/u);
    if (typeof recoveryPath !== "string") {
      throw new Error("Expected a project-local recovery path");
    }
    await expect(
      readFile(join(projectRoot, recoveryPath), "utf8"),
    ).resolves.toBe("prepared bytes\n");

    await expect(
      prepareProjectLocalRemoval({
        projectRoot,
        segments: [".ai-qa", "config.yaml"],
        expected: "file",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "storage.recovery_required",
        details: { recoveryPath },
      }),
    );
  });

  it("reports the same claim-directory recovery path when a post-claim hook removes the entry", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const path = join(projectRoot, ".ai-qa", "config.yaml");
    await writeFile(path, "prepared bytes\n");
    let expectedRecoveryPath: string | undefined;
    const prepared = await prepareProjectLocalRemoval({
      projectRoot,
      segments: [".ai-qa", "config.yaml"],
      expected: "file",
      hooks: {
        afterClaim: async ({ path: claimedPath }) => {
          expectedRecoveryPath = basename(dirname(claimedPath));
          await unlink(claimedPath);
        },
      },
    });

    let firstError: unknown;
    try {
      await prepared.remove();
    } catch (error: unknown) {
      firstError = error;
    }
    expect(firstError).toMatchObject({
      code: "storage.recovery_required",
      details: { recoveryPath: expectedRecoveryPath },
    });
    await expect(
      prepareProjectLocalRemoval({
        projectRoot,
        segments: [".ai-qa", "config.yaml"],
        expected: "file",
      }),
    ).rejects.toMatchObject({
      code: "storage.recovery_required",
      details: { recoveryPath: expectedRecoveryPath },
    });
  });

  it("fails with integrity error and no recovery path when the claim itself disappears", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const path = join(projectRoot, ".ai-qa", "config.yaml");
    await writeFile(path, "prepared bytes\n");
    const prepared = await prepareProjectLocalRemoval({
      projectRoot,
      segments: [".ai-qa", "config.yaml"],
      expected: "file",
      hooks: {
        afterClaim: async ({ path: claimedPath }) => {
          await unlink(claimedPath);
          await rmdir(dirname(claimedPath));
        },
      },
    });

    let thrown: unknown;
    try {
      await prepared.remove();
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "storage.integrity_error",
      message: "Project-local removal claim disappeared after it was claimed",
    });
    expect(thrown).toBeInstanceOf(AiQaError);
    if (!(thrown instanceof AiQaError)) throw new Error("Expected AiQaError");
    expect(thrown.details).not.toHaveProperty("recoveryPath");

    await expect(
      prepareProjectLocalRemoval({
        projectRoot,
        segments: [".ai-qa", "config.yaml"],
        expected: "file",
      }),
    ).resolves.toMatchObject({ relativePath: ".ai-qa/config.yaml" });
  });

  it("reports the lexicographically first retained claim deterministically", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa-removal-claim-zzzzzz"));
    await mkdir(join(projectRoot, ".ai-qa-removal-claim-aaaaaa"));

    await expect(
      prepareProjectLocalRemoval({
        projectRoot,
        segments: [".ai-qa", "config.yaml"],
        expected: "file",
      }),
    ).rejects.toMatchObject({
      code: "storage.recovery_required",
      details: { recoveryPath: ".ai-qa-removal-claim-aaaaaa" },
    });
  });

  it("unlinks a prepared final symlink without removing its destination", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-storage-outside-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const outsideFile = join(outside, "config.yaml");
    const link = join(projectRoot, ".ai-qa", "config.yaml");
    await writeFile(outsideFile, "outside bytes\n");
    await symlink(outsideFile, link);

    const prepared = await prepareProjectLocalRemoval({
      projectRoot,
      segments: [".ai-qa", "config.yaml"],
      expected: "file",
    });

    await expect(prepared.remove()).resolves.toBe(true);
    await expect(access(link)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outsideFile, "utf8")).resolves.toBe(
      "outside bytes\n",
    );
  });

  it("rejects traversal segments before preparing a removal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));

    await expect(
      prepareProjectLocalRemoval({
        projectRoot,
        segments: ["..", "outside"],
        expected: "directory",
      }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
  });

  it("snapshots segments before awaiting project-root canonicalization", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ai-qa-storage-race-"));
    const projectRoot = join(sandbox, "project");
    const outside = join(sandbox, "outside");
    const outsideMarker = join(outside, "marker.txt");
    await Promise.all([mkdir(projectRoot), mkdir(outside)]);
    await writeFile(outsideMarker, "outside bytes\n");
    const segments = [".ai-qa"];

    const preparation = prepareProjectLocalRemoval({
      projectRoot,
      segments,
      expected: "directory",
    });
    segments.splice(0, segments.length, "..", "outside");
    const prepared = await preparation;

    const removed = await prepared.remove();
    await expect(readFile(outsideMarker, "utf8")).resolves.toBe(
      "outside bytes\n",
    );
    expect({ relativePath: prepared.relativePath, removed }).toEqual({
      relativePath: ".ai-qa",
      removed: false,
    });
  });

  it("snapshots segments so caller mutation cannot redirect removal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    const original = join(projectRoot, ".ai-qa", "config.yaml");
    const hardLink = join(projectRoot, ".ai-qa", "other.yaml");
    await writeFile(original, "shared inode\n");
    await link(original, hardLink);
    const segments = [".ai-qa", "config.yaml"];
    const prepared = await prepareProjectLocalRemoval({
      projectRoot,
      segments,
      expected: "file",
    });
    segments[1] = "other.yaml";

    await expect(prepared.remove()).resolves.toBe(true);
    await expect(access(original)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(hardLink, "utf8")).resolves.toBe("shared inode\n");
  });
});
