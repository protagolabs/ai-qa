import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearProject } from "../../src/services/project-clear/clear-project.js";

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function createInitializedProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-project-"));
  await Promise.all([
    mkdir(join(root, ".ai-qa", "cases", "login"), { recursive: true }),
    mkdir(join(root, ".ai-qa", "runs", "run-1"), { recursive: true }),
    mkdir(join(root, ".ai-qa", "run-groups", "group-1"), {
      recursive: true,
    }),
    mkdir(join(root, ".ai-qa", "evidence", "run-1"), { recursive: true }),
    mkdir(join(root, ".ai-qa", "reports", "runs", "run-1"), {
      recursive: true,
    }),
    mkdir(join(root, ".agents", "skills", "ai-qa-project", "references"), {
      recursive: true,
    }),
    mkdir(join(root, ".agents", "skills", "other-skill"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(join(root, ".ai-qa", "config.yaml"), "schemaVersion: 3\n"),
    writeFile(join(root, ".ai-qa", "cases", "login", "case.yaml"), "case"),
    writeFile(join(root, ".ai-qa", "runs", "run-1", "events.jsonl"), "run"),
    writeFile(
      join(root, ".ai-qa", "run-groups", "group-1", "manifest.json"),
      "group",
    ),
    writeFile(
      join(root, ".ai-qa", "evidence", "run-1", "index.jsonl"),
      "evidence",
    ),
    writeFile(
      join(root, ".ai-qa", "reports", "runs", "run-1", "recording.jsonl"),
      "receipt",
    ),
    writeFile(
      join(root, ".agents", "skills", "ai-qa-project", "SKILL.md"),
      "project skill",
    ),
    writeFile(
      join(
        root,
        ".agents",
        "skills",
        "ai-qa-project",
        "references",
        "procedure.md",
      ),
      "procedure",
    ),
    writeFile(
      join(root, ".agents", "skills", "other-skill", "SKILL.md"),
      "other skill",
    ),
  ]);
  return root;
}

describe("clearProject", () => {
  it("clears configuration while preserving every QA record by default", async () => {
    const root = await createInitializedProject();

    await expect(
      clearProject({ projectRoot: root, records: false }),
    ).resolves.toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: false,
      removedPaths: [".ai-qa/config.yaml", ".agents/skills/ai-qa-project"],
    });

    await expectMissing(join(root, ".ai-qa", "config.yaml"));
    await expectMissing(join(root, ".agents", "skills", "ai-qa-project"));
    await expect(
      readFile(join(root, ".ai-qa", "cases", "login", "case.yaml"), "utf8"),
    ).resolves.toBe("case");
    await expect(
      readFile(join(root, ".ai-qa", "runs", "run-1", "events.jsonl"), "utf8"),
    ).resolves.toBe("run");
    await expect(
      readFile(
        join(root, ".ai-qa", "run-groups", "group-1", "manifest.json"),
        "utf8",
      ),
    ).resolves.toBe("group");
    await expect(
      readFile(
        join(root, ".ai-qa", "evidence", "run-1", "index.jsonl"),
        "utf8",
      ),
    ).resolves.toBe("evidence");
    await expect(
      readFile(
        join(root, ".ai-qa", "reports", "runs", "run-1", "recording.jsonl"),
        "utf8",
      ),
    ).resolves.toBe("receipt");
    await expect(
      readFile(
        join(root, ".agents", "skills", "other-skill", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe("other skill");
  });

  it("clears all AI QA state when records are requested", async () => {
    const root = await createInitializedProject();

    await expect(
      clearProject({ projectRoot: root, records: true }),
    ).resolves.toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: true,
      removedPaths: [".ai-qa", ".agents/skills/ai-qa-project"],
    });

    await expectMissing(join(root, ".ai-qa"));
    await expectMissing(join(root, ".agents", "skills", "ai-qa-project"));
    await expect(
      readFile(
        join(root, ".agents", "skills", "other-skill", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe("other skill");
  });

  it("is idempotent when all targets are already absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-empty-"));

    await expect(
      clearProject({ projectRoot: root, records: false }),
    ).resolves.toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: false,
      removedPaths: [],
    });
    await expect(
      clearProject({ projectRoot: root, records: true }),
    ).resolves.toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: true,
      removedPaths: [],
    });
  });

  it("unlinks final-target symlinks without touching outside data", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-symlink-project-"));
    const outside = await mkdtemp(
      join(tmpdir(), "ai-qa-clear-symlink-outside-"),
    );
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    await writeFile(join(outside, "config.yaml"), "outside config");
    await mkdir(join(outside, "project-skill"));
    await writeFile(
      join(outside, "project-skill", "SKILL.md"),
      "outside skill",
    );
    await mkdir(join(root, ".ai-qa"));
    await symlink(
      join(outside, "config.yaml"),
      join(root, ".ai-qa", "config.yaml"),
    );
    await symlink(
      join(outside, "project-skill"),
      join(root, ".agents", "skills", "ai-qa-project"),
    );

    await expect(
      clearProject({ projectRoot: root, records: false }),
    ).resolves.toMatchObject({
      removedPaths: [".ai-qa/config.yaml", ".agents/skills/ai-qa-project"],
    });
    await expect(readFile(join(outside, "config.yaml"), "utf8")).resolves.toBe(
      "outside config",
    );
    await expect(
      readFile(join(outside, "project-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("outside skill");
  });

  it("preflights every target before rejecting a symlinked ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-ancestor-project-"));
    const outside = await mkdtemp(
      join(tmpdir(), "ai-qa-clear-ancestor-outside-"),
    );
    await mkdir(join(root, ".ai-qa"));
    await writeFile(join(root, ".ai-qa", "config.yaml"), "inside config");
    await symlink(outside, join(root, ".agents"));

    await expect(
      clearProject({ projectRoot: root, records: false }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
    await expect(
      readFile(join(root, ".ai-qa", "config.yaml"), "utf8"),
    ).resolves.toBe("inside config");
  });

  it("preflights every target before rejecting a non-directory ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-ancestor-project-"));
    await mkdir(join(root, ".ai-qa"));
    await writeFile(join(root, ".ai-qa", "config.yaml"), "inside config");
    await writeFile(join(root, ".agents"), "not a directory");

    await expect(
      clearProject({ projectRoot: root, records: false }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
    await expect(
      readFile(join(root, ".ai-qa", "config.yaml"), "utf8"),
    ).resolves.toBe("inside config");
  });

  it("unlinks a symlinked .ai-qa entry in records mode", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ai-qa-clear-record-link-project-"),
    );
    const outside = await mkdtemp(
      join(tmpdir(), "ai-qa-clear-record-link-outside-"),
    );
    await writeFile(join(outside, "history.jsonl"), "outside history");
    await symlink(outside, join(root, ".ai-qa"));

    await expect(
      clearProject({ projectRoot: root, records: true }),
    ).resolves.toMatchObject({ removedPaths: [".ai-qa"] });
    await expect(
      readFile(join(outside, "history.jsonl"), "utf8"),
    ).resolves.toBe("outside history");
  });
});
