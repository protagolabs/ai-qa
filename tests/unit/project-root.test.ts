import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProject } from "../../src/services/project-root/resolve-project.js";
import { resolveProjectRoot } from "../../src/services/project-root/resolve-project-root.js";

describe("resolveProjectRoot", () => {
  it("resolves a host-authorized project without machine trust input", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-host-project-"));

    await expect(
      resolveProject({ cwd: root, explicitProject: root }),
    ).resolves.toEqual({ projectRoot: await realpath(root) });
  });

  it("lets explicit --project select a nested project over an ancestor config", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-root-"));
    const nested = join(root, "packages", "app");
    await mkdir(join(root, ".ai-qa"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".ai-qa", "config.yaml"), "schemaVersion: 1\n");

    const resolved = await resolveProjectRoot({
      command: "init",
      cwd: nested,
      explicitProject: nested,
    });

    expect(resolved.root).toBe(await realpath(nested));
    expect(resolved.source).toBe("explicit");
  });

  it("refuses implicit init outside Git when no ancestor config exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-no-git-"));

    await expect(
      resolveProjectRoot({ command: "init", cwd: root }),
    ).rejects.toMatchObject({
      code: "project.explicit_required",
    });
  });

  it("falls back to the Git root when clear has no stored config", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-git-root-"));
    const nested = join(root, "packages", "app");
    await mkdir(join(root, ".git"));
    await mkdir(nested, { recursive: true });

    await expect(
      resolveProjectRoot({ command: "clear", cwd: nested }),
    ).resolves.toEqual({ root: await realpath(root), source: "git-root" });
  });

  it("prefers a configured ancestor over the Git root for clear", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-config-root-"));
    const nestedProject = join(root, "packages", "app");
    const workingDirectory = join(nestedProject, "src");
    await mkdir(join(root, ".git"));
    await mkdir(join(nestedProject, ".ai-qa"), { recursive: true });
    await mkdir(workingDirectory, { recursive: true });
    await writeFile(
      join(nestedProject, ".ai-qa", "config.yaml"),
      "schemaVersion: 3\n",
    );

    await expect(
      resolveProjectRoot({ command: "clear", cwd: workingDirectory }),
    ).resolves.toEqual({
      root: await realpath(nestedProject),
      source: "config-ancestor",
    });
  });

  it("treats a dangling nested config symlink as the nearest configured ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-dangling-root-"));
    const nestedProject = join(root, "packages", "app");
    const workingDirectory = join(nestedProject, "src");
    await mkdir(join(root, ".git"));
    await mkdir(join(root, ".ai-qa"));
    await mkdir(join(nestedProject, ".ai-qa"), { recursive: true });
    await mkdir(workingDirectory);
    await writeFile(join(root, ".ai-qa", "config.yaml"), "schemaVersion: 3\n");
    await symlink(
      join(nestedProject, "missing-config.yaml"),
      join(nestedProject, ".ai-qa", "config.yaml"),
    );

    await expect(
      resolveProjectRoot({ command: "clear", cwd: workingDirectory }),
    ).resolves.toEqual({
      root: await realpath(nestedProject),
      source: "config-ancestor",
    });
  });

  it("requires an explicit clear target outside Git after config removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-no-git-"));

    await expect(
      resolveProjectRoot({ command: "clear", cwd: root }),
    ).rejects.toMatchObject({
      code: "project.explicit_required",
      message: "clear outside Git requires --project <path>",
    });
  });
});
