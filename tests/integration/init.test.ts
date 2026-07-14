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
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  projectConfigSchema,
  type ProjectConfig,
} from "../../src/core/config/schema.js";
import {
  createProjectConfig,
  readProjectConfig,
} from "../../src/core/config/repository.js";
import { runCli } from "../../src/cli/program.js";
import { initializeProject } from "../../src/services/initialization/initialize-project.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { readRepositoryIdentity } from "../../src/services/trust/repository-identity.js";
import { TrustStore } from "../../src/services/trust/trust-store.js";
import { createCapturedCli } from "../helpers/cli-context.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const execFileAsync = promisify(execFile);

const confirmedConfig: ProjectConfig = {
  schemaVersion: 1,
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
  secretReferences: {},
};

describe("initializeProject", () => {
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
        initializeProject({
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
      reason: { code: "project.already_initialized" },
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
      initializeProject({ projectRoot, aiQaHome, config: confirmedConfig }),
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
    await initializeProject({ projectRoot, aiQaHome, config: confirmedConfig });

    await expect(
      initializeProject({
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

    await initializeProject({
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
      initializeProject({
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
    const invalidConfig: ProjectConfig = {
      ...confirmedConfig,
      secretReferences: { login: "correct-horse" },
    };

    await expect(
      initializeProject({ projectRoot, aiQaHome, config: invalidConfig }),
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
    await initializeProject({
      projectRoot: projectA,
      aiQaHome,
      config: configA,
    });
    await initializeProject({
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
  it("preserves project id with inherited global --project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-configure-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    await initializeProject({
      projectRoot,
      aiQaHome,
      config: confirmedConfig,
    });
    const updatedConfig: ProjectConfig = {
      ...confirmedConfig,
      project: { id: "replacement-id", name: "Renamed Web" },
      targets: { web: { entryUrl: "http://127.0.0.1:4000" } },
    };
    const captured = createCapturedCli({
      cwd: tmpdir(),
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(JSON.stringify(updatedConfig)),
    });

    const exitCode = await runCli(
      ["--project", projectRoot, "configure", "--stdin-json"],
      captured.context,
    );

    const output = JSON.parse(captured.stdout.join("")) as ProjectConfig;
    const stored = parse(
      await readFile(join(projectRoot, ".ai-qa", "config.yaml"), "utf8"),
    ) as ProjectConfig;
    expect(exitCode).toBe(0);
    expect(output.project).toEqual({ id: "sample-web", name: "Renamed Web" });
    expect(stored.project.id).toBe("sample-web");
    expect(stored.targets.web.entryUrl).toBe("http://127.0.0.1:4000");
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
