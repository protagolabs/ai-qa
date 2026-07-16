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
  checkGlobalSkillForProject,
  previewGlobalSkillSync,
  syncGlobalSkill,
} from "../../src/services/skill-management/global-skill.js";
import { mergeManagedSkill } from "../../src/services/skill-management/managed-skill.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import {
  copyReleasedLegacyGlobalSkill,
  installReleasedLegacyGlobalSkill,
  installedGlobalSkillReference,
  readReleasedLegacyGlobalSkill,
} from "../helpers/global-skill-fixture.js";

const canonicalSkill = `---
name: ai-qa
description: QA
metadata:
  aiQaSkillVersion: 1.2.0
  aiQaProtocolRange: ^1.2.0
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
  await copyReleasedLegacyGlobalSkill(sourceDirectory);
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
        "  aiQaSkillVersion: 1.2.0\n",
        "",
      ),
    },
    {
      operation: "preview",
      malformedSource: canonicalSkill.replace(
        "  aiQaProtocolRange: ^1.2.0",
        "  aiQaProtocolRange: 1",
      ),
    },
    {
      operation: "sync",
      malformedSource: canonicalSkill.replace(
        "  aiQaSkillVersion: 1.2.0\n",
        "",
      ),
    },
    {
      operation: "sync",
      malformedSource: canonicalSkill.replace(
        "  aiQaProtocolRange: ^1.2.0",
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
      "aiQaSkillVersion: 1.2.0",
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

  it("rejects a valid 1.0 skill for every current recording mode", async () => {
    const fixture = await createSkillFixture();
    await installReleasedLegacyGlobalSkill(fixture.agentsHome);

    await expect(checkGlobalSkill(fixture)).resolves.toMatchObject({
      status: "stale",
    });
    await expect(
      checkGlobalSkillForProject({
        ...fixture,
        recordingMode: "local-only",
      }),
    ).resolves.toMatchObject({ status: "stale" });
    await expect(
      checkGlobalSkillForProject({
        ...fixture,
        recordingMode: "project-skill",
      }),
    ).resolves.toMatchObject({ status: "stale" });
  });

  it.each([
    { condition: "missing", expected: "stale" },
    { condition: "tampered", expected: "conflict" },
  ] as const)(
    "rejects the current 1.2 skill when its managed reference is $condition",
    async ({ condition, expected }) => {
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

  it("rejects a checksum-self-consistent impostor claiming current 1.2", async () => {
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

  it("keeps the current 1.2 user region outside managed checksum pinning", async () => {
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

  it.each([{ condition: "missing" }, { condition: "tampered" }] as const)(
    "rejects a released legacy 1.0 skill when its pinned reference is $condition",
    async ({ condition }) => {
      const fixture = await createSkillFixture();
      await installReleasedLegacyGlobalSkill(fixture.agentsHome);
      const installedReference = installedGlobalSkillReference(
        fixture.agentsHome,
      );
      if (condition === "missing") {
        await unlink(installedReference);
      } else {
        await writeFile(installedReference, "# Unknown legacy reference\n");
      }

      await expect(
        checkGlobalSkillForProject({
          ...fixture,
          recordingMode: "local-only",
        }),
      ).resolves.toMatchObject({ status: "stale" });
      await expect(
        checkGlobalSkillForProject({
          ...fixture,
          recordingMode: "project-skill",
        }),
      ).resolves.toMatchObject({ status: "stale" });
    },
  );

  it("rejects a checksum-self-consistent impostor claiming legacy 1.0", async () => {
    const fixture = await createSkillFixture();
    await installReleasedLegacyGlobalSkill(fixture.agentsHome);
    const forged = (await readReleasedLegacyGlobalSkill()).replace(
      "# AI QA Workflow",
      "# Forged AI QA Workflow",
    );
    await writeFile(
      fixture.destination,
      mergeManagedSkill({
        source: forged,
        confirmManagedReplacement: false,
      }).content,
    );

    await expect(
      checkGlobalSkillForProject({
        ...fixture,
        recordingMode: "local-only",
      }),
    ).resolves.toMatchObject({ status: "stale" });
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

describe("bundled global skill 1.2", () => {
  it("teaches the host-managed Project Skill procedure", async () => {
    const skill = await readFile(
      join(process.cwd(), "src", "skills", "global", "SKILL.md"),
      "utf8",
    );
    const reference = await readFile(
      join(
        process.cwd(),
        "src",
        "skills",
        "global",
        "references",
        "web-work-protocol.md",
      ),
      "utf8",
    );
    const guidance = `${skill}\n${reference}`;

    expect.soft(skill).toContain("  aiQaSkillVersion: 1.2.0");
    expect.soft(skill).toContain("  aiQaProtocolRange: ^1.2.0");
    expect.soft(skill).toContain("  aiQaRecordingReceipt: true");
    expect.soft(skill).toContain("  aiQaManagedChecksum: bundled");
    for (const fact of [
      "Use `skill-creator` to create or update `.agents/skills/ai-qa-project/SKILL.md` in scratch space before target write.",
      "Codex validates the config and Project Skill, displays both complete diffs, obtains one confirmation, then writes both project files.",
      "When no existing result-management procedure exists, use `recordingPolicy.mode: local-only`; do not choose a provider from available tools.",
      "The target Project Skill is project-owned; do not add AI-QA managed/user markers or an embedded AI-QA checksum.",
      "Run `ai-qa config validate --stdin-json` as a read-only config check.",
      "Before drafting, run the applicable installation doctor and host-visible checks; treat a missing config as `uninitialized`, then discuss startup, targets, environments, authentication/test data, evidence, retention, reports, reruns, Git, CI, secrets, and result recording.",
      "Before confirmation or write, reject literal secrets and unsupported secret handling, and verify both target files are inside the exact project root and are not symlink targets.",
      "Only after config validation, scratch Project Skill validation, and all path, symlink, and secret safety checks succeed may Codex request the one confirmation; that confirmation authorizes only the two target writes and four canonical project-local directories, followed by the post-write doctor.",
      "The one confirmation does not authorize the post-write doctor; after the approved writes and directory creation complete, Codex runs doctor as a separate mandatory verification step.",
      "Run `ai-qa doctor --json` after the host-managed write.",
      "For project-skill runs, execute the exact Project Skill procedure only after a verified report and submit only status/references.",
      "Never retry an external result-recording operation submitted as `unknown`; scope observation-gated recovery to non-recording Web actions.",
      "Permissions, authentication, file writes, and external tools remain host-owned.",
    ]) {
      expect.soft(guidance).toContain(fact);
    }
    expect.soft(reference).toContain("## Canonical schema-v2 config draft");
    expect.soft(reference).toContain("targets:\n  web:\n    entryUrl:");
    expect
      .soft(reference)
      .toContain('tools:\n  web:\n    controller: "chrome-devtools-mcp"');
    expect
      .soft(reference)
      .toContain(
        "evidencePolicy:\n  screenshots: required\n  defaultSensitivity: internal",
      );
    expect
      .soft(reference)
      .toContain("storagePolicy:\n  adapter: project-local");
    expect
      .soft(reference)
      .toContain("secretReferences: {}\nrecordingPolicy:\n  mode: local-only");
    expect
      .soft(reference)
      .toContain("A request to show the approval decision is proposal-only");
    expect
      .soft(reference)
      .toContain(
        "Project Skill drafted and validated with `skill-creator` in scratch space; target write waits for this one confirmation.",
      );
    expect.soft(reference).toContain(`## Required pre-confirmation attestation

Immediately before the approval question, include all four lines:

- Complete config validation: MUST PASS BEFORE CONFIRMATION.
- Scratch Project Skill validation with \`skill-creator\`: MUST PASS BEFORE CONFIRMATION.
- Exact-root and target/parent symlink safety: MUST PASS BEFORE CONFIRMATION.
- Literal-secret and unsupported-secret-handling safety: MUST PASS BEFORE CONFIRMATION.`);
    expect.soft(guidance).not.toContain("InitializationRequest");
    expect.soft(guidance).not.toContain("initializationRequestSchema");
    expect.soft(guidance).not.toContain("projectSkill.content");
    expect.soft(guidance).not.toMatch(/(?:managed-)?checksum algorithm/i);
    expect.soft(guidance).not.toContain("createHash");
    expect.soft(guidance).not.toContain("SHA-256");
    expect.soft(guidance).not.toContain("--confirm-checksum");
    expect.soft(guidance).not.toContain("ai-qa skill generate --project");
    expect.soft(guidance).not.toContain("ai-qa skill sync --project");
    expect.soft(guidance).not.toMatch(/\b(?:GitHub|Jira|Notion|Linear)\b/i);
  });

  it("ships the exact trust confirmation stdin accepted by the CLI", async () => {
    const skill = await readFile(
      join(process.cwd(), "src", "skills", "global", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain(
      'pipe exactly `{"confirmed":true}` to `ai-qa trust confirm --project <path> --stdin-json`; no other stdin fields are accepted.',
    );

    const reference = await readFile(
      join(
        process.cwd(),
        "src",
        "skills",
        "global",
        "references",
        "web-work-protocol.md",
      ),
      "utf8",
    );
    const match =
      /<!-- canonical-trust-confirm:start -->\s*```text\r?\n([^\r\n]+)\r?\n```\s*<!-- canonical-trust-confirm:end -->/.exec(
        reference,
      );
    expect(match?.[1], "canonical trust confirmation stdin").toBeDefined();
    const stdin = match?.[1];
    if (stdin === undefined) {
      throw new Error("Canonical trust confirmation stdin is missing");
    }
    expect(stdin).toBe('{"confirmed":true}');

    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-project-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    for (const invalid of ['{"trusted":true}', "{}"] as const) {
      const captured = createCapturedCli({
        cwd: projectRoot,
        env: { AI_QA_HOME: aiQaHome },
        readStdin: () => Promise.resolve(invalid),
      });
      await expect(
        runCli(
          ["trust", "confirm", "--project", projectRoot, "--stdin-json"],
          captured.context,
        ),
      ).resolves.toBe(1);
    }

    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(stdin),
    });
    await expect(
      runCli(
        ["trust", "confirm", "--project", projectRoot, "--stdin-json"],
        captured.context,
      ),
    ).resolves.toBe(0);
  });

  it("labels the local Project Skill body example as arbitrary and unmanaged", async () => {
    const reference = await readFile(
      join(
        process.cwd(),
        "src",
        "skills",
        "global",
        "references",
        "web-work-protocol.md",
      ),
      "utf8",
    );
    const match =
      /### Arbitrary local Project Skill body example[\s\S]*?```markdown\r?\n([\s\S]*?)\r?\n```/.exec(
        reference,
      );

    expect(match?.[1], "arbitrary local Project Skill body").toBeDefined();
    expect(match?.[1]).toContain("# Sample Web Project Procedures");
    expect(match?.[1]).toContain("without creating an external record");
    expect(match?.[1]).not.toContain("---");
    expect(match?.[1]).not.toContain("metadata:");
    expect(match?.[1]).not.toContain("ai-qa:managed");
    expect(reference).toContain("It is not a provider contract.");
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
    ).toContain("aiQaSkillVersion: 1.2.0");
    expect(await runCli(["skill", "check", "--global"], captured.context)).toBe(
      0,
    );
  });
});
