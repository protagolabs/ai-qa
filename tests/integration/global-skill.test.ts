import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import {
  checkGlobalSkill,
  previewGlobalSkillSync,
  syncGlobalSkill,
} from "../../src/services/skill-management/global-skill.js";
import { createCapturedCli } from "../helpers/cli-context.js";

const canonicalSkill = `---
name: ai-qa
description: QA
metadata:
  aiQaSkillVersion: 1.0.0
  aiQaProtocolRange: ^1.0.0
  aiQaManagedChecksum: bundled
---
<!-- ai-qa:managed:start -->
flow
<!-- ai-qa:managed:end -->
<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
`;

async function createSkillFixture(
  references: Readonly<Record<string, string>> = {
    "web-work-protocol.md": "# Protocol\n",
  },
): Promise<{
  agentsHome: string;
  sourcePath: string;
  destination: string;
}> {
  const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-agents-"));
  const sourceDirectory = join(agentsHome, "canonical");
  const sourcePath = join(sourceDirectory, "SKILL.md");
  await mkdir(join(sourceDirectory, "references"), { recursive: true });
  await writeFile(sourcePath, canonicalSkill);
  for (const [relativePath, content] of Object.entries(references)) {
    const path = join(sourceDirectory, "references", relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return {
    agentsHome,
    sourcePath,
    destination: join(agentsHome, "skills", "ai-qa", "SKILL.md"),
  };
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("syncGlobalSkill", () => {
  it.each([
    {
      operation: "preview",
      malformedSource: canonicalSkill.replace(
        "  aiQaSkillVersion: 1.0.0\n",
        "",
      ),
    },
    {
      operation: "preview",
      malformedSource: canonicalSkill.replace(
        "  aiQaProtocolRange: ^1.0.0",
        "  aiQaProtocolRange: 1",
      ),
    },
    {
      operation: "sync",
      malformedSource: canonicalSkill.replace(
        "  aiQaSkillVersion: 1.0.0\n",
        "",
      ),
    },
    {
      operation: "sync",
      malformedSource: canonicalSkill.replace(
        "  aiQaProtocolRange: ^1.0.0",
        "  aiQaProtocolRange: 1",
      ),
    },
  ] as const)(
    "rejects malformed global source metadata during $operation",
    async ({ operation, malformedSource }) => {
      const fixture = await createSkillFixture();
      await writeFile(fixture.sourcePath, malformedSource);

      const request =
        operation === "preview"
          ? previewGlobalSkillSync(fixture)
          : syncGlobalSkill({
              ...fixture,
              confirmManagedReplacement: false,
            });

      await expect(request).rejects.toMatchObject({
        code: "skill.invalid_frontmatter",
      });
      await expectMissing(fixture.destination);
    },
  );

  it("installs explicitly and refuses silent replacement", async () => {
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-agents-"));
    const sourceDirectory = join(agentsHome, "canonical");
    const sourcePath = join(sourceDirectory, "SKILL.md");
    await mkdir(join(sourceDirectory, "references"), { recursive: true });
    await writeFile(
      sourcePath,
      `---\nname: ai-qa\ndescription: QA\nmetadata:\n  aiQaSkillVersion: 1.0.0\n  aiQaProtocolRange: ^1.0.0\n  aiQaManagedChecksum: bundled\n---\n<!-- ai-qa:managed:start -->\nflow\n<!-- ai-qa:managed:end -->\n<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->\n`,
    );
    await writeFile(
      join(sourceDirectory, "references", "web-work-protocol.md"),
      "# Protocol\n",
    );

    await syncGlobalSkill({
      agentsHome,
      sourcePath,
      confirmManagedReplacement: false,
    });
    const destination = join(agentsHome, "skills", "ai-qa", "SKILL.md");
    expect(await readFile(destination, "utf8")).toContain(
      "aiQaSkillVersion: 1.0.0",
    );
    expect(
      await readFile(
        join(
          agentsHome,
          "skills",
          "ai-qa",
          "references",
          "web-work-protocol.md",
        ),
        "utf8",
      ),
    ).toBe("# Protocol\n");

    await mkdir(join(agentsHome, "skills", "ai-qa"), { recursive: true });
    await writeFile(
      destination,
      (await readFile(destination, "utf8")).replace("flow", "edited"),
    );
    const preview = await previewGlobalSkillSync({ agentsHome, sourcePath });
    expect(preview).toMatchObject({
      changed: true,
      requiresConfirmation: true,
    });
    expect(preview.unifiedDiff).toContain("-edited");
    expect(preview.unifiedDiff).toContain("+flow");
    await expect(
      syncGlobalSkill({
        agentsHome,
        sourcePath,
        confirmManagedReplacement: false,
      }),
    ).rejects.toMatchObject({ code: "skill.managed_conflict" });
  });

  it("copies a missing managed reference without confirmation", async () => {
    const fixture = await createSkillFixture();
    await syncGlobalSkill({
      ...fixture,
      confirmManagedReplacement: false,
    });
    const installedReference = join(
      dirname(fixture.destination),
      "references",
      "web-work-protocol.md",
    );
    await unlink(installedReference);

    await expect(
      syncGlobalSkill({
        ...fixture,
        confirmManagedReplacement: false,
      }),
    ).resolves.toMatchObject({ changed: true });
    await expect(readFile(installedReference, "utf8")).resolves.toBe(
      "# Protocol\n",
    );
  });

  it("requires confirmation before replacing a changed managed reference", async () => {
    const fixture = await createSkillFixture();
    await syncGlobalSkill({
      ...fixture,
      confirmManagedReplacement: false,
    });
    const installedReference = join(
      dirname(fixture.destination),
      "references",
      "web-work-protocol.md",
    );
    await writeFile(installedReference, "# Local edit\n");

    await expect(previewGlobalSkillSync(fixture)).resolves.toMatchObject({
      changed: true,
      requiresConfirmation: true,
    });
    await expect(
      syncGlobalSkill({
        ...fixture,
        confirmManagedReplacement: false,
      }),
    ).rejects.toMatchObject({ code: "skill.reference_conflict" });
    await expect(readFile(installedReference, "utf8")).resolves.toBe(
      "# Local edit\n",
    );
  });

  it("keeps destination-only user files during synchronization", async () => {
    const fixture = await createSkillFixture();
    await syncGlobalSkill({
      ...fixture,
      confirmManagedReplacement: false,
    });
    const userFile = join(dirname(fixture.destination), "my-notes.md");
    await writeFile(userFile, "Keep this file\n");

    await syncGlobalSkill({
      ...fixture,
      confirmManagedReplacement: false,
    });

    await expect(readFile(userFile, "utf8")).resolves.toBe("Keep this file\n");
  });

  it("discovers all reference conflicts before writing queued changes", async () => {
    const fixture = await createSkillFixture({
      "a-missing.md": "# Missing\n",
      "z-conflict.md": "# Canonical\n",
    });
    await syncGlobalSkill({
      ...fixture,
      confirmManagedReplacement: false,
    });
    const referenceDirectory = join(dirname(fixture.destination), "references");
    const missingReference = join(referenceDirectory, "a-missing.md");
    const conflictingReference = join(referenceDirectory, "z-conflict.md");
    await unlink(missingReference);
    await writeFile(conflictingReference, "# Local edit\n");
    await writeFile(
      fixture.sourcePath,
      canonicalSkill.replace("\nflow\n", "\nupdated flow\n"),
    );
    const installedBefore = await readFile(fixture.destination, "utf8");

    await expect(
      syncGlobalSkill({
        ...fixture,
        confirmManagedReplacement: false,
      }),
    ).rejects.toMatchObject({ code: "skill.reference_conflict" });

    await expectMissing(missingReference);
    await expect(readFile(conflictingReference, "utf8")).resolves.toBe(
      "# Local edit\n",
    );
    await expect(readFile(fixture.destination, "utf8")).resolves.toBe(
      installedBefore,
    );
  });

  it("keeps preview and check read-only for missing, stale, and conflict states", async () => {
    const missing = await createSkillFixture();
    await expect(previewGlobalSkillSync(missing)).resolves.toMatchObject({
      changed: true,
      requiresConfirmation: false,
    });
    await expect(checkGlobalSkill(missing)).resolves.toMatchObject({
      status: "missing",
    });
    await expectMissing(missing.destination);

    const stale = await createSkillFixture();
    await syncGlobalSkill({
      ...stale,
      confirmManagedReplacement: false,
    });
    await writeFile(
      stale.sourcePath,
      canonicalSkill.replace("\nflow\n", "\nupdated flow\n"),
    );
    const staleBefore = await readFile(stale.destination, "utf8");
    await expect(previewGlobalSkillSync(stale)).resolves.toMatchObject({
      changed: true,
      requiresConfirmation: false,
    });
    await expect(checkGlobalSkill(stale)).resolves.toMatchObject({
      status: "stale",
    });
    await expect(readFile(stale.destination, "utf8")).resolves.toBe(
      staleBefore,
    );

    const conflict = await createSkillFixture();
    await syncGlobalSkill({
      ...conflict,
      confirmManagedReplacement: false,
    });
    const conflictBefore = (
      await readFile(conflict.destination, "utf8")
    ).replace("\nflow\n", "\nlocal edit\n");
    await writeFile(conflict.destination, conflictBefore);
    await expect(previewGlobalSkillSync(conflict)).resolves.toMatchObject({
      changed: true,
      requiresConfirmation: true,
    });
    await expect(checkGlobalSkill(conflict)).resolves.toMatchObject({
      status: "conflict",
    });
    await expect(readFile(conflict.destination, "utf8")).resolves.toBe(
      conflictBefore,
    );
  });

  it("treats an installed CRLF skill as compatible without rewriting it", async () => {
    const fixture = await createSkillFixture();
    await syncGlobalSkill({
      ...fixture,
      confirmManagedReplacement: false,
    });
    const crlfInstalled = (await readFile(fixture.destination, "utf8")).replace(
      /\n/g,
      "\r\n",
    );
    await writeFile(fixture.destination, crlfInstalled);

    await expect(previewGlobalSkillSync(fixture)).resolves.toMatchObject({
      changed: false,
      requiresConfirmation: false,
    });
    await expect(checkGlobalSkill(fixture)).resolves.toMatchObject({
      status: "compatible",
    });
    await expect(readFile(fixture.destination, "utf8")).resolves.toBe(
      crlfInstalled,
    );
  });
});

describe("global skill CLI", () => {
  it("rejects project-only sync options in global mode without writing", async () => {
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-agents-"));
    const captured = createCapturedCli({
      env: { AI_QA_AGENTS_HOME: agentsHome },
    });

    expect(
      await runCli(
        ["skill", "sync", "--global", "--preview"],
        captured.context,
      ),
    ).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: { code: "skill.conflicting_scope_options" },
    });
    await expectMissing(join(agentsHome, "skills", "ai-qa", "SKILL.md"));
  });

  it("reports a missing global skill as JSON with a nonzero exit", async () => {
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-agents-"));
    const captured = createCapturedCli({
      env: { AI_QA_AGENTS_HOME: agentsHome },
    });

    expect(await runCli(["skill", "check", "--global"], captured.context)).toBe(
      1,
    );
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
      status: "missing",
      destination: join(agentsHome, "skills", "ai-qa", "SKILL.md"),
    });
  });

  it("installs and checks the bundled skill using the injected agents home", async () => {
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-agents-"));
    const captured = createCapturedCli({
      env: { AI_QA_AGENTS_HOME: agentsHome },
    });

    expect(
      await runCli(["skill", "install", "--global"], captured.context),
    ).toBe(0);
    expect(
      await readFile(join(agentsHome, "skills", "ai-qa", "SKILL.md"), "utf8"),
    ).toContain("aiQaSkillVersion: 1.0.0");
    expect(await runCli(["skill", "check", "--global"], captured.context)).toBe(
      0,
    );
  });
});
