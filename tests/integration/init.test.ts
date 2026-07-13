import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  projectConfigSchema,
  type ProjectConfig,
} from "../../src/core/config/schema.js";
import { runCli } from "../../src/cli/program.js";
import { initializeProject } from "../../src/services/initialization/initialize-project.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { createCapturedCli } from "../helpers/cli-context.js";

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
