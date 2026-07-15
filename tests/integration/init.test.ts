import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  projectConfigSchema,
  type ProjectConfig,
} from "../../src/core/config/schema.js";
import {
  createProjectConfig,
  readProjectConfig,
} from "../../src/core/config/repository.js";
import { runCli } from "../../src/cli/program.js";
import type { InitializationRequest } from "../../src/services/initialization/project-setup.js";
import { prepareProjectSkill } from "../../src/services/skill-management/project-skill.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { readRepositoryIdentity } from "../../src/services/trust/repository-identity.js";
import { TrustStore } from "../../src/services/trust/trust-store.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import {
  initializeTestProject,
  projectConfigV1,
  projectSkillSource,
} from "../helpers/project-fixture.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const execFileAsync = promisify(execFile);

const confirmedConfig: ProjectConfig = {
  schemaVersion: 2,
  recordingPolicy: { mode: "local-only" },
  project: { id: "sample-web", name: "Sample Web" },
  targets: { web: { entryUrl: "http://127.0.0.1:3000" } },
  environments: {},
  tools: { web: { controller: "chrome-devtools-mcp" } },
  evidencePolicy: {
    screenshots: "required",
    defaultSensitivity: "internal",
    retentionDays: 30,
  },
  reportPolicy: {
    formats: ["markdown", "json"],
    audience: "engineering",
    detail: "full",
  },
  storagePolicy: { adapter: "project-local" },
  gitPolicy: { config: "track", artifacts: "ignore" },
  ciPolicy: { nonPassExit: "failure" },
  secretReferences: { fixtureProjectSkill: "QA_TEST_PASSWORD" },
};

function setupRequest(
  config: ProjectConfig = confirmedConfig,
): InitializationRequest {
  return {
    config: {
      ...config,
      secretReferences: {
        ...config.secretReferences,
        login: "QA_TEST_PASSWORD",
      },
    },
    projectSkill: {
      reason: "Project-specific QA procedures",
      content: projectSkillSource(),
    },
  };
}

describe("complete project initialization", () => {
  it("keeps direct config creation create-only", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-config-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    await createProjectConfig(projectRoot, confirmedConfig);

    await expect(
      createProjectConfig(projectRoot, {
        ...confirmedConfig,
        project: { id: "replacement-id", name: "Replacement" },
      }),
    ).rejects.toMatchObject({ code: "project.already_initialized" });
    await expect(readProjectConfig(projectRoot)).resolves.toMatchObject({
      project: { id: "sample-web" },
    });
  });

  it("does not remove an unowned config staging file", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-config-project-"));
    const directory = join(projectRoot, ".ai-qa");
    await mkdir(directory);
    const uuid = "00000000-0000-4000-8000-000000000000";
    const stagingPath = join(directory, `config.yaml.${uuid}.tmp`);
    await writeFile(stagingPath, "owned by another creator");
    vi.mocked(randomUUID).mockReturnValueOnce(uuid);

    await expect(
      createProjectConfig(projectRoot, confirmedConfig),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(stagingPath, "utf8")).resolves.toBe(
      "owned by another creator",
    );
    await expect(access(join(directory, "config.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes concurrent initialization to one complete winner", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-init-project-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-init-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    const projectIds = ["concurrent-a", "concurrent-b"] as const;

    const results = await Promise.allSettled(
      projectIds.map((projectId) =>
        initializeTestProject({
          projectRoot,
          aiQaHome,
          config: {
            ...confirmedConfig,
            project: { id: projectId, name: projectId },
          },
        }),
      ),
    );
    const winners = results.flatMap((result, index) =>
      result.status === "fulfilled" ? [projectIds[index]!] : [],
    );
    const failures = results.filter((result) => result.status === "rejected");

    expect(winners).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      status: "rejected",
      reason: { code: "setup.checksum_mismatch" },
    });
    await expect(readProjectConfig(projectRoot)).resolves.toMatchObject({
      project: { id: winners[0] },
    });
  });

  it("never follows a symlinked .ai-qa directory", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-init-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-init-outside-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-init-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    await symlink(outside, join(projectRoot, ".ai-qa"));

    await expect(
      initializeTestProject({ projectRoot, aiQaHome, config: confirmedConfig }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
    await expect(access(join(outside, "config.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses reinitialization and preserves the original project id", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-init-project-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-init-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    await initializeTestProject({
      projectRoot,
      aiQaHome,
      config: confirmedConfig,
    });

    await expect(
      initializeTestProject({
        projectRoot,
        aiQaHome,
        config: {
          ...confirmedConfig,
          project: { id: "replacement-id", name: "Replacement" },
        },
      }),
    ).rejects.toMatchObject({ code: "project.already_initialized" });
    await expect(readProjectConfig(projectRoot)).resolves.toMatchObject({
      project: { id: "sample-web" },
    });
  });

  it("writes project state locally and trust only to the machine store", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-project-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));

    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });

    await initializeTestProject({
      projectRoot,
      aiQaHome,
      config: confirmedConfig,
    });

    const config = parse(
      await readFile(join(projectRoot, ".ai-qa", "config.yaml"), "utf8"),
    ) as ProjectConfig;
    const trust = JSON.parse(
      await readFile(join(aiQaHome, "trust.json"), "utf8"),
    ) as {
      entries: unknown[];
    };
    expect(config.project.id).toBe("sample-web");
    expect(trust.entries).toHaveLength(1);
    await expect(
      readFile(join(projectRoot, ".ai-qa", "trust.json"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not accept project config as proof of trust", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-untrusted-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));

    await expect(
      initializeTestProject({
        projectRoot,
        aiQaHome,
        config: confirmedConfig,
      }),
    ).rejects.toMatchObject({ code: "trust.not_trusted" });
    await expect(access(join(projectRoot, ".ai-qa"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves no project state when configuration is invalid", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-invalid-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    const invalidConfig: ProjectConfig = {
      ...confirmedConfig,
      secretReferences: { login: "correct-horse" },
    };

    await expect(
      initializeTestProject({ projectRoot, aiQaHome, config: invalidConfig }),
    ).rejects.toThrow("Use an environment-variable name, not a secret value");
    await expect(access(join(projectRoot, ".ai-qa"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("isolates project config while sharing the machine trust store", async () => {
    const projectA = await mkdtemp(join(tmpdir(), "ai-qa-project-a-"));
    const projectB = await mkdtemp(join(tmpdir(), "ai-qa-project-b-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    const configA: ProjectConfig = {
      ...confirmedConfig,
      project: { id: "project-a", name: "Project A" },
    };
    const configB: ProjectConfig = {
      ...confirmedConfig,
      project: { id: "project-b", name: "Project B" },
    };

    for (const projectRoot of [projectA, projectB]) {
      await confirmProjectTrust({
        projectRoot,
        aiQaHome,
        confirmed: true,
        now: new Date("2026-07-13T00:00:00.000Z"),
      });
    }
    await initializeTestProject({
      projectRoot: projectA,
      aiQaHome,
      config: configA,
    });
    await initializeTestProject({
      projectRoot: projectB,
      aiQaHome,
      config: configB,
    });

    const serializedA = await readFile(
      join(projectA, ".ai-qa", "config.yaml"),
      "utf8",
    );
    const serializedB = await readFile(
      join(projectB, ".ai-qa", "config.yaml"),
      "utf8",
    );
    expect((parse(serializedA) as ProjectConfig).project.id).toBe("project-a");
    expect((parse(serializedB) as ProjectConfig).project.id).toBe("project-b");
    expect(serializedA).not.toContain(projectB);
    expect(serializedA).not.toContain("project-b");
    expect(serializedB).not.toContain(projectA);
    expect(serializedB).not.toContain("project-a");
  });
});

describe("projectConfigSchema", () => {
  it("accepts environment-variable secret references and rejects secret values", () => {
    expect(() =>
      projectConfigSchema.parse({
        ...confirmedConfig,
        secretReferences: { login: "correct-horse" },
      }),
    ).toThrow();
    expect(
      projectConfigSchema.parse({
        ...confirmedConfig,
        secretReferences: { login: "AI_QA_LOGIN_PASSWORD" },
      }).secretReferences,
    ).toEqual({ login: "AI_QA_LOGIN_PASSWORD" });
  });
});

describe("trust confirm CLI", () => {
  it("rejects confirmation payloads with fields beyond confirmed true", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-project-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () =>
        Promise.resolve('{"confirmed":true,"unreviewed":"value"}'),
    });

    const exitCode = await runCli(
      ["trust", "confirm", "--project", projectRoot, "--stdin-json"],
      captured.context,
    );

    expect(exitCode).toBe(1);
    expect(captured.stderr.join("")).toContain("input.invalid_json");
    await expect(
      readFile(join(aiQaHome, "trust.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("machine trust boundary", () => {
  it("waits for a transiently contended trust lock", async () => {
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-trust-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-trust-project-"));
    const identity = await readRepositoryIdentity(projectRoot);
    const store = new TrustStore(aiQaHome);
    const release = await lockfile.lock(aiQaHome, { realpath: false });
    const delayedRelease = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        release().then(resolve, reject);
      }, 2_500);
    });

    try {
      await store.trust(identity, new Date("2026-07-13T00:00:00.000Z"));
    } finally {
      await delayedRelease;
    }

    await expect(store.isTrusted(identity)).resolves.toBe(true);
  });

  it("preserves every concurrent trust confirmation", async () => {
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-trust-home-"));
    const roots = await Promise.all(
      Array.from({ length: 20 }, () =>
        mkdtemp(join(tmpdir(), "ai-qa-trust-project-")),
      ),
    );
    const identities = await Promise.all(roots.map(readRepositoryIdentity));
    const store = new TrustStore(aiQaHome);

    await Promise.all(
      identities.map((identity) =>
        store.trust(identity, new Date("2026-07-13T00:00:00.000Z")),
      ),
    );

    await expect(
      Promise.all(identities.map((identity) => store.isTrusted(identity))),
    ).resolves.toEqual(Array.from({ length: 20 }, () => true));
  });

  it("invalidates trust when repository identity changes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-identity-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    await execFileAsync("git", ["init", projectRoot]);
    const initialIdentity = await readRepositoryIdentity(projectRoot);
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });

    await execFileAsync("git", [
      "-C",
      projectRoot,
      "remote",
      "add",
      "origin",
      "https://example.invalid/org/repository.git",
    ]);
    const changedIdentity = await readRepositoryIdentity(projectRoot);

    expect(changedIdentity.fingerprint).not.toBe(initialIdentity.fingerprint);
    await expect(
      new TrustStore(aiQaHome).isTrusted(changedIdentity),
    ).resolves.toBe(false);
  });

  it("keeps trust status read-only and secret-safe", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-status-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    const fakeSecret = "fake-token-review-123";
    await execFileAsync("git", ["init", projectRoot]);
    await execFileAsync("git", [
      "-C",
      projectRoot,
      "remote",
      "add",
      "origin",
      `https://oauth2:${fakeSecret}@example.invalid/org/repository.git`,
    ]);
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: aiQaHome },
    });

    const exitCode = await runCli(
      ["trust", "status", "--project", projectRoot],
      captured.context,
    );

    const stdout = captured.stdout.join("");
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(exitCode).toBe(0);
    expect(output).toEqual({
      canonicalPath: await realpath(projectRoot),
      fingerprint: output.fingerprint,
      trusted: false,
    });
    expect(typeof output.fingerprint).toBe("string");
    expect(output.fingerprint).toHaveLength(64);
    expect(stdout).not.toContain("remoteUrl");
    expect(`${stdout}${captured.stderr.join("")}`).not.toContain(fakeSecret);
    await expect(access(join(aiQaHome, "trust.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("configured project CLI boundary", () => {
  it("requires exactly one confirmation option and rejects conflicting options through Commander", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-init-options-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    const input = JSON.stringify(setupRequest());

    const missing = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.reject(new Error("stdin must not be read")),
    });
    expect(
      await runCli(
        ["--project", projectRoot, "init", "--stdin-json"],
        missing.context,
      ),
    ).toBe(1);
    expect(JSON.parse(missing.stderr.join(""))).toMatchObject({
      error: { code: "setup.confirmation_required" },
    });

    const conflicting = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(input),
    });
    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "init",
          "--stdin-json",
          "--preview",
          "--confirm-checksum",
          `sha256:${"0".repeat(64)}`,
        ],
        conflicting.context,
      ),
    ).toBe(1);
    expect(JSON.parse(conflicting.stderr.join(""))).toMatchObject({
      error: { code: "commander.conflictingOption" },
    });
    await expect(access(join(projectRoot, ".ai-qa"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("previews and checksum-confirms a complete v2 init request", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-init-cli-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    const input = JSON.stringify(setupRequest());
    const previewCli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(input),
    });

    expect(
      await runCli(
        ["--project", projectRoot, "init", "--stdin-json", "--preview"],
        previewCli.context,
      ),
    ).toBe(0);
    const preview = JSON.parse(previewCli.stdout.join("")) as {
      checksum: string;
      operation: string;
      writePaths: string[];
    };
    expect(preview).toMatchObject({
      operation: "init",
      writePaths: [
        ".ai-qa/config.yaml",
        ".agents/skills/ai-qa-project/SKILL.md",
      ],
    });
    expect(preview.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(access(join(projectRoot, ".ai-qa"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const applyCli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(input),
    });
    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "init",
          "--stdin-json",
          "--confirm-checksum",
          preview.checksum,
        ],
        applyCli.context,
      ),
    ).toBe(0);
    expect(JSON.parse(applyCli.stdout.join(""))).toEqual({
      projectRoot: await realpath(projectRoot),
      operation: "init",
      configPath: ".ai-qa/config.yaml",
      projectSkillPath: ".agents/skills/ai-qa-project/SKILL.md",
      writePaths: [
        ".ai-qa/config.yaml",
        ".agents/skills/ai-qa-project/SKILL.md",
      ],
      checksum: preview.checksum,
      recordingMode: "local-only",
      createdDirectories: ["cases", "runs", "evidence", "reports/runs"],
    });
    await expect(
      readFile(
        join(projectRoot, ".agents", "skills", "ai-qa-project", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toMatch(/aiQaManagedChecksum: [a-f0-9]{64}/);
  });

  it("rejects v1 init input and revalidates resubmitted confirmation stdin", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-init-v1-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    const v1Cli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            config: projectConfigV1(),
            projectSkill: setupRequest().projectSkill,
          }),
        ),
    });
    expect(
      await runCli(
        ["--project", projectRoot, "init", "--stdin-json", "--preview"],
        v1Cli.context,
      ),
    ).toBe(1);
    expect(JSON.parse(v1Cli.stderr.join(""))).toMatchObject({
      error: { code: "input.invalid_json" },
    });

    const previewCli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(JSON.stringify(setupRequest())),
    });
    await runCli(
      ["--project", projectRoot, "init", "--stdin-json", "--preview"],
      previewCli.context,
    );
    const preview = JSON.parse(previewCli.stdout.join("")) as {
      checksum: string;
    };
    const changed = setupRequest({
      ...confirmedConfig,
      project: { ...confirmedConfig.project, name: "Changed submission" },
    });
    const applyCli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(JSON.stringify(changed)),
    });
    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "init",
          "--stdin-json",
          "--confirm-checksum",
          preview.checksum,
        ],
        applyCli.context,
      ),
    ).toBe(1);
    expect(JSON.parse(applyCli.stderr.join(""))).toMatchObject({
      error: { code: "setup.checksum_mismatch" },
    });
    await expect(
      access(join(projectRoot, ".ai-qa", "config.yaml")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("previews v1 migration without writes, then applies full state while preserving project id", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-configure-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    const legacy = projectConfigV1();
    const legacyBytes = `# keep legacy bytes until apply\n${stringify(legacy)}`;
    await mkdir(join(projectRoot, ".ai-qa", "runs"), { recursive: true });
    await writeFile(join(projectRoot, ".ai-qa", "config.yaml"), legacyBytes);
    await writeFile(
      join(projectRoot, ".ai-qa", "runs", "existing.json"),
      "keep\n",
    );
    const installedSkill = prepareProjectSkill({
      source: projectSkillSource("Record with the existing procedure."),
      secretReferences: legacy.secretReferences,
    }).content;
    await mkdir(join(projectRoot, ".agents", "skills", "ai-qa-project"), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, ".agents", "skills", "ai-qa-project", "SKILL.md"),
      installedSkill,
    );
    const updatedConfig: ProjectConfig = {
      ...confirmedConfig,
      project: { id: "replacement-id", name: "Renamed Web" },
      targets: { web: { entryUrl: "http://127.0.0.1:4000" } },
      secretReferences: legacy.secretReferences,
    };
    const request = setupRequest(updatedConfig);
    request.projectSkill = {
      reason: "Updated project procedures",
      content: projectSkillSource("Record with the migrated procedure."),
    };
    const refused = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(JSON.stringify(request)),
    });
    expect(
      await runCli(
        ["--project", projectRoot, "configure", "--stdin-json"],
        refused.context,
      ),
    ).toBe(1);
    expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
      error: { code: "setup.confirmation_required" },
    });
    await expect(
      readFile(join(projectRoot, ".ai-qa", "config.yaml"), "utf8"),
    ).resolves.toBe(legacyBytes);
    await expect(
      readFile(join(projectRoot, ".ai-qa", "runs", "existing.json"), "utf8"),
    ).resolves.toBe("keep\n");

    const previewCli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(JSON.stringify(request)),
    });
    expect(
      await runCli(
        ["--project", projectRoot, "configure", "--stdin-json", "--preview"],
        previewCli.context,
      ),
    ).toBe(0);
    const preview = JSON.parse(previewCli.stdout.join("")) as {
      checksum: string;
      config: ProjectConfig;
    };
    expect(preview.config).toMatchObject({
      schemaVersion: 2,
      project: { id: "sample-web", name: "Renamed Web" },
    });
    await expect(
      readFile(join(projectRoot, ".ai-qa", "config.yaml"), "utf8"),
    ).resolves.toBe(legacyBytes);

    const applyCli = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(JSON.stringify(request)),
    });
    const confirmedExitCode = await runCli(
      [
        "--project",
        projectRoot,
        "configure",
        "--stdin-json",
        "--confirm-checksum",
        preview.checksum,
      ],
      applyCli.context,
    );
    const stored = parse(
      await readFile(join(projectRoot, ".ai-qa", "config.yaml"), "utf8"),
    ) as ProjectConfig;
    expect(confirmedExitCode).toBe(0);
    expect(JSON.parse(applyCli.stdout.at(-1)!)).toMatchObject({
      operation: "configure",
      recordingMode: "local-only",
      createdDirectories: [],
    });
    expect(stored.project.id).toBe("sample-web");
    expect(stored.schemaVersion).toBe(2);
    expect(stored.targets.web.entryUrl).toBe("http://127.0.0.1:4000");
    await expect(
      readFile(join(projectRoot, ".ai-qa", "runs", "existing.json"), "utf8"),
    ).resolves.toBe("keep\n");
  });

  it("emits a stable structured error without stack leakage", async () => {
    const captured = createCapturedCli();

    const exitCode = await runCli(["trust", "status"], captured.context);

    const stderr = captured.stderr.join("");
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: "project.explicit_required",
        message: "trust commands require --project <path>",
        details: {},
      },
    });
    expect(stderr.toLowerCase()).not.toContain("stack");
    expect(captured.stdout).toEqual([]);
  });
});
