import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureProjectLocalDirectory,
  inspectOptionalProjectLocalRegularFile,
  requireProjectLocalRegularFile,
} from "../../src/core/fs/project-storage.js";

describe("project-local storage", () => {
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
});
