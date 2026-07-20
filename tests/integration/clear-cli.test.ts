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
import { runCli } from "../../src/cli/program.js";
import { createCapturedCli } from "../helpers/cli-context.js";

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function initializeCliProject(root: string): Promise<void> {
  await Promise.all([
    mkdir(join(root, ".ai-qa", "runs", "run-1"), { recursive: true }),
    mkdir(join(root, ".agents", "skills", "ai-qa-project"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(join(root, ".ai-qa", "config.yaml"), "schemaVersion: 3\n"),
    writeFile(join(root, ".ai-qa", "runs", "run-1", "events.jsonl"), "run"),
    writeFile(
      join(root, ".agents", "skills", "ai-qa-project", "SKILL.md"),
      "skill",
    ),
  ]);
}

async function createCliProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-cli-"));
  await initializeCliProject(root);
  return root;
}

describe("clear CLI", () => {
  it("clears only configuration for the exact explicit nested project", async () => {
    const ancestor = await createCliProject();
    const nested = join(ancestor, "packages", "app");
    await initializeCliProject(nested);
    const captured = createCapturedCli({ cwd: ancestor });

    expect(await runCli(["--project", nested, "clear"], captured.context)).toBe(
      0,
    );
    expect(JSON.parse(captured.stdout.join(""))).toEqual({
      status: "cleared",
      projectRoot: await realpath(nested),
      records: false,
      removedPaths: [".ai-qa/config.yaml", ".agents/skills/ai-qa-project"],
    });
    expect(captured.stderr).toEqual([]);
    await expectMissing(join(nested, ".ai-qa", "config.yaml"));
    await expectMissing(join(nested, ".agents", "skills", "ai-qa-project"));
    await expect(
      readFile(join(nested, ".ai-qa", "runs", "run-1", "events.jsonl"), "utf8"),
    ).resolves.toBe("run");
    await expect(
      readFile(join(ancestor, ".ai-qa", "config.yaml"), "utf8"),
    ).resolves.toBe("schemaVersion: 3\n");
    await expect(
      readFile(
        join(ancestor, ".ai-qa", "runs", "run-1", "events.jsonl"),
        "utf8",
      ),
    ).resolves.toBe("run");
    await expect(
      readFile(
        join(ancestor, ".agents", "skills", "ai-qa-project", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe("skill");
  });

  it("clears records and remains repeatable through Git-root fallback", async () => {
    const root = await createCliProject();
    await mkdir(join(root, ".git"));
    const first = createCapturedCli({ cwd: root });

    expect(await runCli(["clear", "--records"], first.context)).toBe(0);
    expect(JSON.parse(first.stdout.join(""))).toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: true,
      removedPaths: [".ai-qa", ".agents/skills/ai-qa-project"],
    });
    expect(first.stderr).toEqual([]);
    await expectMissing(join(root, ".ai-qa"));
    await expectMissing(join(root, ".agents", "skills", "ai-qa-project"));

    const second = createCapturedCli({ cwd: root });
    expect(await runCli(["clear", "--records"], second.context)).toBe(0);
    expect(JSON.parse(second.stdout.join(""))).toEqual({
      status: "cleared",
      projectRoot: await realpath(root),
      records: true,
      removedPaths: [],
    });
    expect(second.stderr).toEqual([]);
  });

  it("reports retained claim recovery instead of treating missing targets as success", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-clear-cli-recovery-"));
    await mkdir(join(root, ".ai-qa-removal-claim-aaaaaa"));
    const captured = createCapturedCli({ cwd: root });

    expect(await runCli(["--project", root, "clear"], captured.context)).toBe(
      1,
    );
    expect(captured.stdout).toEqual([]);
    expect(JSON.parse(captured.stderr.join(""))).toEqual({
      error: {
        code: "storage.recovery_required",
        message:
          "Project-local removal recovery is required before another clear",
        details: { recoveryPath: ".ai-qa-removal-claim-aaaaaa" },
      },
    });
  });

  it("implicitly clears a nested dangling config symlink instead of the Git-root project", async () => {
    const root = await createCliProject();
    const nested = join(root, "packages", "app");
    await mkdir(join(root, ".git"));
    await mkdir(join(nested, ".ai-qa"), { recursive: true });
    await mkdir(join(nested, ".agents", "skills", "ai-qa-project"), {
      recursive: true,
    });
    await symlink(
      join(nested, "missing-config.yaml"),
      join(nested, ".ai-qa", "config.yaml"),
    );
    await writeFile(
      join(nested, ".agents", "skills", "ai-qa-project", "SKILL.md"),
      "nested skill",
    );
    const captured = createCapturedCli({ cwd: nested });

    expect(await runCli(["clear"], captured.context)).toBe(0);
    expect(JSON.parse(captured.stdout.join(""))).toEqual({
      status: "cleared",
      projectRoot: await realpath(nested),
      records: false,
      removedPaths: [".ai-qa/config.yaml", ".agents/skills/ai-qa-project"],
    });
    expect(captured.stderr).toEqual([]);
    await expectMissing(join(nested, ".ai-qa", "config.yaml"));
    await expectMissing(join(nested, ".agents", "skills", "ai-qa-project"));
    await expect(
      readFile(join(root, ".ai-qa", "config.yaml"), "utf8"),
    ).resolves.toBe("schemaVersion: 3\n");
    await expect(
      readFile(
        join(root, ".agents", "skills", "ai-qa-project", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe("skill");
  });
});
