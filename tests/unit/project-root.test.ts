import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
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
});
