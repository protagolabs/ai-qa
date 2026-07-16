import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCurrentProjectSkillSnapshot,
  readProjectSkillSnapshot,
} from "../../src/services/project-skill/project-skill-file.js";

const projectSkillPath = ".agents/skills/ai-qa-project/SKILL.md";

async function createProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ai-qa-project-skill-"));
}

async function expectProjectSkillError(
  operation: () => Promise<unknown>,
  input: { projectRoot: string; code: string },
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error: unknown) {
    caught = error;
  }

  expect(caught).toEqual(
    expect.objectContaining({
      code: input.code,
      details: { path: projectSkillPath },
    }),
  );
  expect(
    JSON.stringify((caught as { details: unknown }).details),
  ).not.toContain(input.projectRoot);
}

describe("project Skill file identity", () => {
  it("hashes the exact UTF-8 bytes of a regular project-local Skill", async () => {
    const projectRoot = await createProjectRoot();
    const source = "---\nname: ai-qa-project\n---\n\nRecord the result.\n";
    const directory = join(projectRoot, ".agents", "skills", "ai-qa-project");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), source, "utf8");

    await expect(readProjectSkillSnapshot(projectRoot)).resolves.toEqual({
      path: projectSkillPath,
      contentSha256: createHash("sha256").update(source).digest("hex"),
    });
  });

  it("maps a missing Skill to a project-relative integrity error", async () => {
    const projectRoot = await createProjectRoot();

    await expectProjectSkillError(() => readProjectSkillSnapshot(projectRoot), {
      projectRoot,
      code: "project_skill.integrity_error",
    });
  });

  it("maps a symlinked ancestor to a project-relative integrity error", async () => {
    const projectRoot = await createProjectRoot();
    const outside = await createProjectRoot();
    await mkdir(join(projectRoot, ".agents"));
    await mkdir(join(outside, "ai-qa-project"));
    await writeFile(join(outside, "ai-qa-project", "SKILL.md"), "outside\n");
    await symlink(outside, join(projectRoot, ".agents", "skills"));

    await expectProjectSkillError(() => readProjectSkillSnapshot(projectRoot), {
      projectRoot,
      code: "project_skill.integrity_error",
    });
  });

  it("maps a symlinked SKILL.md to a project-relative integrity error", async () => {
    const projectRoot = await createProjectRoot();
    const directory = join(projectRoot, ".agents", "skills", "ai-qa-project");
    const realSkill = join(projectRoot, "real-SKILL.md");
    await mkdir(directory, { recursive: true });
    await writeFile(realSkill, "real\n");
    await symlink(realSkill, join(directory, "SKILL.md"));

    await expectProjectSkillError(() => readProjectSkillSnapshot(projectRoot), {
      projectRoot,
      code: "project_skill.integrity_error",
    });
  });

  it("rejects a byte change using only project-relative error details", async () => {
    const projectRoot = await createProjectRoot();
    const directory = join(projectRoot, ".agents", "skills", "ai-qa-project");
    const path = join(directory, "SKILL.md");
    await mkdir(directory, { recursive: true });
    await writeFile(path, "original bytes\n");
    const snapshot = await readProjectSkillSnapshot(projectRoot);
    await writeFile(path, "changed bytes\n");

    await expectProjectSkillError(
      () => assertCurrentProjectSkillSnapshot({ projectRoot, snapshot }),
      { projectRoot, code: "project_skill.changed" },
    );
  });
});
