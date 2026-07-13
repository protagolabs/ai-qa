import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  projectConfigSchema,
  type ProjectConfig,
} from "../../src/core/config/schema.js";
import { runCli } from "../../src/cli/program.js";
import { initializeProject } from "../../src/services/initialization/initialize-project.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { readRepositoryIdentity } from "../../src/services/trust/repository-identity.js";
import { TrustStore } from "../../src/services/trust/trust-store.js";
import { createCapturedCli } from "../helpers/cli-context.js";

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
