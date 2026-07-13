import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import {
  previewGlobalSkillSync,
  syncGlobalSkill,
} from "../../src/services/skill-management/global-skill.js";
import { createCapturedCli } from "../helpers/cli-context.js";

describe("syncGlobalSkill", () => {
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
});

describe("global skill CLI", () => {
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
