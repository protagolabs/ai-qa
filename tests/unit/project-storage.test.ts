import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureProjectLocalDirectory,
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
});
