import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import {
  checkGlobalSkill,
  checkGlobalSkillForProject,
  previewGlobalSkillSync,
  syncGlobalSkill,
} from "../../src/services/skill-management/global-skill.js";
import { mergeManagedSkill } from "../../src/services/skill-management/managed-skill.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import {
  installedGlobalSkillReference,
} from "../helpers/global-skill-fixture.js";

const canonicalSkill = `---
name: ai-qa
description: QA
metadata:
  aiQaSkillVersion: 2.0.0
  aiQaProtocolRange: ^2.0.0
  aiQaRecordingReceipt: true
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
    "shared-work-protocol.md": "# Shared protocol\n",
    "web-controller.md": "# Web controller\n",
    "ios-simulator-controller.md": "# iOS Simulator controller\n",
    "android-emulator-controller.md": "# Android Emulator controller\n",
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
        "  aiQaSkillVersion: 2.0.0\n",
        "",
      ),
    },
    {
      operation: "preview",
      malformedSource: canonicalSkill.replace(
        "  aiQaProtocolRange: ^2.0.0",
        "  aiQaProtocolRange: 1",
      ),
    },
    {
      operation: "sync",
      malformedSource: canonicalSkill.replace(
        "  aiQaSkillVersion: 2.0.0\n",
        "",
      ),
    },
    {
      operation: "sync",
      malformedSource: canonicalSkill.replace(
        "  aiQaProtocolRange: ^2.0.0",
        "  aiQaProtocolRange: 1",
      ),
    },
    {
      operation: "preview",
      malformedSource: canonicalSkill.replace(
        "  aiQaRecordingReceipt: true\n",
        "",
      ),
    },
    {
      operation: "sync",
      malformedSource: canonicalSkill.replace(
        "  aiQaRecordingReceipt: true",
        "  aiQaRecordingReceipt: disabled",
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
    await writeFile(sourcePath, canonicalSkill);
    await writeFile(
      join(sourceDirectory, "references", "shared-work-protocol.md"),
      "# Shared protocol\n",
    );

    await syncGlobalSkill({
      agentsHome,
      sourcePath,
      confirmManagedReplacement: false,
    });
    const destination = join(agentsHome, "skills", "ai-qa", "SKILL.md");
    expect(await readFile(destination, "utf8")).toContain(
      "aiQaSkillVersion: 2.0.0",
    );
    expect(
      await readFile(
        join(
          agentsHome,
          "skills",
          "ai-qa",
          "references",
          "shared-work-protocol.md",
        ),
        "utf8",
      ),
    ).toBe("# Shared protocol\n");

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
      "shared-work-protocol.md",
    );
    await unlink(installedReference);

    await expect(
      syncGlobalSkill({
        ...fixture,
        confirmManagedReplacement: false,
      }),
    ).resolves.toMatchObject({ changed: true });
    await expect(readFile(installedReference, "utf8")).resolves.toBe(
      "# Shared protocol\n",
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
      "shared-work-protocol.md",
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

  it.each([
    { condition: "missing", expected: "stale" },
    { condition: "tampered", expected: "conflict" },
  ] as const)(
    "rejects the current 2.0 skill when its managed reference is $condition",
    async ({ condition, expected }) => {
      const fixture = await createSkillFixture();
      await syncGlobalSkill({
        ...fixture,
        confirmManagedReplacement: false,
      });
      const installedReference = join(
        dirname(fixture.destination),
        "references",
        "shared-work-protocol.md",
      );
      if (condition === "missing") {
        await unlink(installedReference);
      } else {
        await writeFile(installedReference, "# Locally modified protocol\n");
      }

      for (const recordingMode of ["local-only", "project-skill"] as const) {
        await expect(
          checkGlobalSkillForProject({ ...fixture, recordingMode }),
        ).resolves.toMatchObject({ status: expected });
      }
    },
  );

  it("rejects a checksum-self-consistent impostor claiming current 2.0", async () => {
    const fixture = await createSkillFixture();
    await syncGlobalSkill({
      ...fixture,
      confirmManagedReplacement: false,
    });
    const forged = canonicalSkill.replace("\nflow\n", "\nforged flow\n");
    await writeFile(
      fixture.destination,
      mergeManagedSkill({
        source: forged,
        confirmManagedReplacement: false,
      }).content,
    );

    for (const recordingMode of ["local-only", "project-skill"] as const) {
      await expect(
        checkGlobalSkillForProject({ ...fixture, recordingMode }),
      ).resolves.toMatchObject({ status: "stale" });
    }
  });

  it("keeps the current 2.0 user region outside managed checksum pinning", async () => {
    const fixture = await createSkillFixture();
    await syncGlobalSkill({
      ...fixture,
      confirmManagedReplacement: false,
    });
    await writeFile(
      fixture.destination,
      (await readFile(fixture.destination, "utf8")).replace(
        "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
        "<!-- ai-qa:user:start -->\nlocal user note\n<!-- ai-qa:user:end -->",
      ),
    );

    for (const recordingMode of ["local-only", "project-skill"] as const) {
      await expect(
        checkGlobalSkillForProject({ ...fixture, recordingMode }),
      ).resolves.toMatchObject({ status: "compatible" });
    }
  });

  it("removes stale managed references only after confirmed synchronization", async () => {
    const fixture = await createSkillFixture();
    await syncGlobalSkill({
      ...fixture,
      confirmManagedReplacement: false,
    });
    const stale = installedGlobalSkillReference(
      fixture.agentsHome,
      "web-work-protocol.md",
    );
    await writeFile(stale, "# Retired Web-only protocol\n");

    await expect(
      syncGlobalSkill({
        ...fixture,
        confirmManagedReplacement: false,
      }),
    ).rejects.toMatchObject({ code: "skill.reference_conflict" });
    await expect(readFile(stale, "utf8")).resolves.toContain("Retired");

    await expect(
      syncGlobalSkill({ ...fixture, confirmManagedReplacement: true }),
    ).resolves.toMatchObject({ changed: true });
    await expectMissing(stale);
    expect(
      (
        await readdir(join(dirname(fixture.destination), "references"))
      ).sort(),
    ).toEqual([
      "android-emulator-controller.md",
      "ios-simulator-controller.md",
      "shared-work-protocol.md",
      "web-controller.md",
    ]);
  });

  it("requires the receipt capability for strict bundled skill checks", async () => {
    const fixture = await createSkillFixture();
    const disabledCapability = canonicalSkill.replace(
      "  aiQaRecordingReceipt: true",
      "  aiQaRecordingReceipt: false",
    );
    await mkdir(dirname(fixture.destination), { recursive: true });
    await writeFile(
      fixture.destination,
      mergeManagedSkill({
        source: disabledCapability,
        confirmManagedReplacement: false,
      }).content,
    );

    await expect(checkGlobalSkill(fixture)).resolves.toMatchObject({
      status: "stale",
    });
  });
});

describe("bundled global skill 2.0", () => {
  it("routes setup and execution across the three configured platforms", async () => {
    const root = join(process.cwd(), "src", "skills", "global");
    const skill = await readFile(join(root, "SKILL.md"), "utf8");
    const references = await Promise.all(
      [
        "shared-work-protocol.md",
        "web-controller.md",
        "ios-simulator-controller.md",
        "android-emulator-controller.md",
      ].map((name) => readFile(join(root, "references", name), "utf8")),
    );
    const guidance = [skill, ...references].join("\n");

    expect.soft(skill).toContain("aiQaSkillVersion: 2.0.0");
    expect.soft(skill).toContain("aiQaProtocolRange: ^2.0.0");
    expect.soft(skill).toContain("web, ios-simulator, and android-emulator");
    expect.soft(skill).toContain("ask which configured platform subset");
    expect
      .soft(guidance)
      .toContain(
        "multi-platform exploratory QA starts one explicit exploratory run per selected platform",
      );
    expect
      .soft(guidance)
      .toContain("Multi-platform regression uses a RunGroup");
    expect
      .soft(guidance)
      .toContain("Configuration never selects execution platforms");
    expect.soft(skill).not.toContain("schema-v2");
    expect.soft(skill).not.toContain("automatically run all");
    for (const fact of [
      "non-empty deployed platform selection",
      "collect every selected platform's required configuration",
      "Always ask the user to explicitly choose `recordingPolicy.mode`",
      "schema 3",
      "displays both complete diffs",
      "Doctor every configured platform",
      "Real devices are unsupported",
      "The CLI never invokes controllers",
      "RunGroup",
      "aggregate report",
      "recording",
    ]) {
      expect.soft(guidance).toContain(fact);
    }
    expect.soft(guidance).toContain("chrome-devtools-mcp");
    expect.soft(guidance).toContain("pepper");
    expect.soft(guidance).toContain("appium");
    expect.soft(guidance).toContain("uiautomator2");
    expect.soft(guidance).not.toContain("web-work-protocol.md");
  });

  it("contains exactly the current one-level reference set", async () => {
    const referenceDirectory = join(
      process.cwd(),
      "src",
      "skills",
      "global",
      "references",
    );
    expect((await readdir(referenceDirectory)).sort()).toEqual([
      "android-emulator-controller.md",
      "ios-simulator-controller.md",
      "shared-work-protocol.md",
      "web-controller.md",
    ]);
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
      error: { code: "commander.unknownOption" },
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
    ).toContain("aiQaSkillVersion: 2.0.0");
    expect(await runCli(["skill", "check", "--global"], captured.context)).toBe(
      0,
    );
  });
});
