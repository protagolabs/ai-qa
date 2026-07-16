import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { runInstallationDoctor } from "../../src/services/doctor/installation-doctor.js";
import { syncGlobalSkill } from "../../src/services/skill-management/global-skill.js";
import { installReleasedLegacyGlobalSkill } from "../helpers/global-skill-fixture.js";
import {
  initializeTestProject,
  projectConfigV1,
  projectConfigV2,
} from "../helpers/project-fixture.js";

const projectSkillPath = ".agents/skills/ai-qa-project/SKILL.md";

function bundledSourcePath(): string {
  return fileURLToPath(
    new URL("../../src/skills/global/SKILL.md", import.meta.url),
  );
}

async function installCurrentGlobalSkill(agentsHome: string): Promise<void> {
  await syncGlobalSkill({
    agentsHome,
    sourcePath: bundledSourcePath(),
    confirmManagedReplacement: true,
  });
}

async function fixture(input?: {
  config?: ReturnType<typeof projectConfigV2>;
  installGlobalSkill?: boolean;
}): Promise<{ projectRoot: string; agentsHome: string }> {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "ai-qa-doctor-unit-project-"),
  );
  const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-doctor-unit-agents-"));
  await initializeTestProject({
    projectRoot,
    aiQaHome: await mkdtemp(join(tmpdir(), "ai-qa-doctor-unit-home-")),
    config: input?.config ?? projectConfigV2(),
  });
  if (input?.installGlobalSkill !== false) {
    await installCurrentGlobalSkill(agentsHome);
  }
  return { projectRoot, agentsHome };
}

async function projectFiles(
  root: string,
  current = root,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await projectFiles(root, path));
    } else if (entry.isFile()) {
      result[relative(root, path)] = await readFile(path, "utf8");
    }
  }
  return result;
}

function check(
  result: Awaited<ReturnType<typeof runInstallationDoctor>>,
  code: (typeof result.checks)[number]["code"],
) {
  return result.checks.find((candidate) => candidate.code === code);
}

describe("runInstallationDoctor", () => {
  it("reports an uninitialized project without creating or changing files", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-doctor-uninitialized-"),
    );
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-doctor-agents-"));
    await installCurrentGlobalSkill(agentsHome);
    const before = await projectFiles(projectRoot);

    const result = await runInstallationDoctor({
      projectRoot,
      agentsHome,
      sourcePath: bundledSourcePath(),
    });

    expect(result.status).toBe("uninitialized");
    expect(check(result, "project.config")).toMatchObject({
      status: "missing",
    });
    expect(check(result, "agent.project_skill")).toMatchObject({
      status: "missing",
    });
    expect(await projectFiles(projectRoot)).toEqual(before);
  });

  it.each(["local-only", "project-skill"] as const)(
    "requires a regular Project Skill for initialized config v2 mode %s",
    async (mode) => {
      const { projectRoot, agentsHome } = await fixture({
        config: projectConfigV2(mode),
      });
      await rm(join(projectRoot, projectSkillPath));

      const result = await runInstallationDoctor({
        projectRoot,
        agentsHome,
        sourcePath: bundledSourcePath(),
      });

      expect(result.status).toBe("not_ready");
      const projectSkill = check(result, "agent.project_skill");
      expect(projectSkill).toMatchObject({ status: "fail" });
      expect(projectSkill?.message).toContain(projectSkillPath);
    },
  );

  it("keeps a missing Project Skill advisory for stored config v1", async () => {
    const { projectRoot, agentsHome } = await fixture();
    await writeFile(
      join(projectRoot, ".ai-qa", "config.yaml"),
      stringify(projectConfigV1(), { sortMapEntries: true }),
      "utf8",
    );
    await rm(join(projectRoot, projectSkillPath));

    const result = await runInstallationDoctor({
      projectRoot,
      agentsHome,
      sourcePath: bundledSourcePath(),
    });

    expect(result.status).toBe("ready");
    const projectSkill = check(result, "agent.project_skill");
    expect(projectSkill).toMatchObject({ status: "advisory" });
    expect(projectSkill?.message).toContain(projectSkillPath);
  });

  it("fails a symlinked Project Skill without exposing absolute paths", async () => {
    const { projectRoot, agentsHome } = await fixture();
    const outside = join(
      await mkdtemp(join(tmpdir(), "ai-qa-doctor-outside-")),
      "SKILL.md",
    );
    await writeFile(outside, "outside\n", "utf8");
    await rm(join(projectRoot, projectSkillPath));
    await symlink(outside, join(projectRoot, projectSkillPath));

    const result = await runInstallationDoctor({
      projectRoot,
      agentsHome,
      sourcePath: bundledSourcePath(),
    });

    expect(result.status).toBe("not_ready");
    const projectSkill = check(result, "agent.project_skill");
    expect(projectSkill).toMatchObject({ status: "fail" });
    expect(projectSkill?.message).toContain(projectSkillPath);
    expect(JSON.stringify(result)).not.toContain(projectRoot);
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it.each(["missing", "stale", "conflict"] as const)(
    "fails when the global main Skill is %s",
    async (globalStatus) => {
      const { projectRoot, agentsHome } = await fixture({
        installGlobalSkill: false,
      });
      if (globalStatus === "stale") {
        await installReleasedLegacyGlobalSkill(agentsHome);
      } else if (globalStatus === "conflict") {
        await installCurrentGlobalSkill(agentsHome);
        await writeFile(
          join(agentsHome, "skills", "ai-qa", "SKILL.md"),
          "invalid global Skill\n",
          "utf8",
        );
      }

      const result = await runInstallationDoctor({
        projectRoot,
        agentsHome,
        sourcePath: bundledSourcePath(),
      });

      expect(result.status).toBe("not_ready");
      const globalSkill = check(result, "agent.global_skill");
      expect(globalSkill).toMatchObject({ status: "fail" });
      expect(globalSkill?.message).toContain(globalStatus);
      expect(JSON.stringify(result)).not.toContain(agentsHome);
    },
  );

  it("fails when a canonical storage directory is missing", async () => {
    const { projectRoot, agentsHome } = await fixture();
    await rm(join(projectRoot, ".ai-qa", "cases"), { recursive: true });

    const result = await runInstallationDoctor({
      projectRoot,
      agentsHome,
      sourcePath: bundledSourcePath(),
    });

    expect(result.status).toBe("not_ready");
    const storage = check(result, "project.storage");
    expect(storage).toMatchObject({ status: "fail" });
    expect(storage?.message).toContain(".ai-qa/cases");
  });

  it("fails when a canonical storage directory is not writable", async () => {
    const { projectRoot, agentsHome } = await fixture();
    const evidence = join(projectRoot, ".ai-qa", "evidence");
    await chmod(evidence, 0o500);
    try {
      const result = await runInstallationDoctor({
        projectRoot,
        agentsHome,
        sourcePath: bundledSourcePath(),
      });

      expect(result.status).toBe("not_ready");
      const storage = check(result, "project.storage");
      expect(storage).toMatchObject({ status: "fail" });
      expect(storage?.message).toContain(".ai-qa/evidence");
    } finally {
      await chmod(evidence, 0o700);
    }
  });

  it("reports a ready installation without mutating any project file", async () => {
    const { projectRoot, agentsHome } = await fixture();
    const before = await projectFiles(projectRoot);

    const result = await runInstallationDoctor({
      projectRoot,
      agentsHome,
      sourcePath: bundledSourcePath(),
    });

    expect(result.status).toBe("ready");
    expect(
      result.checks.every((candidate) => candidate.status === "pass"),
    ).toBe(true);
    expect(await projectFiles(projectRoot)).toEqual(before);
    expect(JSON.stringify(result)).not.toContain(projectRoot);
    expect(JSON.stringify(result)).not.toContain(dirname(projectRoot));
  });
});
