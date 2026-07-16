import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/program.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { syncGlobalSkill } from "../../src/services/skill-management/global-skill.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import { installReleasedLegacyGlobalSkill } from "../helpers/global-skill-fixture.js";
import { initializeTestProject } from "../helpers/project-fixture.js";

const config: ProjectConfig = {
  schemaVersion: 2,
  recordingPolicy: { mode: "local-only" },
  project: { id: "doctor-web", name: "Doctor Web" },
  targets: {
    web: {
      entryUrl: "http://127.0.0.1:3000",
      readinessUrl: "http://127.0.0.1:3000/health",
    },
  },
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

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }
  return files.sort();
}

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

describe("web doctor CLI", () => {
  it("reports an uninitialized explicit non-Git target without trust or Web checks", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-doctor-empty-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-doctor-home-"));
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-doctor-agents-"));
    await installCurrentGlobalSkill(agentsHome);
    const fetchImpl = vi.fn<typeof fetch>();
    const readStdin = vi.fn(() => Promise.reject(new Error("stdin read")));
    const captured = createCapturedCli({
      cwd: tmpdir(),
      env: {
        AI_QA_HOME: aiQaHome,
        AI_QA_AGENTS_HOME: agentsHome,
      },
      fetchImpl,
      readStdin,
    });
    const before = await listFiles(projectRoot);

    const exitCode = await runCli(
      ["--project", projectRoot, "doctor", "--json"],
      captured.context,
    );

    expect(exitCode).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readStdin).not.toHaveBeenCalled();
    const output = JSON.parse(captured.stdout.join("")) as {
      status: string;
      requiredAction: unknown;
      checks: Array<{ code: string; status: string }>;
    };
    expect(output).toMatchObject({
      status: "uninitialized",
    });
    expect(output.requiredAction).toEqual({
      kind: "configure-project",
      blocking: true,
      reason: "project-config-missing",
    });
    expect(
      output.checks.find((check) => check.code === "project.config"),
    ).toMatchObject({ status: "missing" });
    expect(
      output.checks.find((check) => check.code === "agent.project_skill"),
    ).toMatchObject({ status: "missing" });
    expect(await listFiles(projectRoot)).toEqual(before);
  });

  it.each([
    ["platform only", ["--platform", "web"]],
    ["stdin only", ["--stdin-json"]],
  ] as const)(
    "rejects the incomplete doctor option pair: %s",
    async (_name, pair) => {
      const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-doctor-empty-"));
      const captured = createCapturedCli({ cwd: projectRoot });

      const exitCode = await runCli(
        ["doctor", "--json", ...pair],
        captured.context,
      );

      expect(exitCode).toBe(1);
      expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
        error: { code: "doctor.options_pair_required" },
      });
    },
  );

  it("reports readiness without mutating project state", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-doctor-project-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-doctor-home-"));
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-doctor-agents-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    await initializeTestProject({ projectRoot, aiQaHome, config });

    await installCurrentGlobalSkill(agentsHome);

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: {
        AI_QA_HOME: aiQaHome,
        AI_QA_AGENTS_HOME: agentsHome,
      },
      fetchImpl,
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            chromeDevtoolsMcp: {
              status: "ready",
              observedAt: "2026-07-13T00:00:00.000Z",
              evidence: "Chrome DevTools MCP listed the target page",
            },
          }),
        ),
    });
    const beforeProject = await listFiles(projectRoot);
    const beforeAgents = await listFiles(agentsHome);

    const exitCode = await runCli(
      ["doctor", "--platform", "web", "--json", "--stdin-json"],
      captured.context,
    );

    expect(exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(config.targets.web.readinessUrl);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const output = JSON.parse(captured.stdout.join("")) as {
      status: string;
      requiredAction: unknown;
      checks: Array<{ code: string; status: string; message: string }>;
    };
    expect(output.status).toBe("ready");
    expect(output.requiredAction).toBeNull();
    expect(output.checks.map((check) => check.code)).toEqual([
      "runtime.node",
      "agent.global_skill",
      "project.config",
      "agent.project_skill",
      "project.storage",
      "web.entry_url",
      "web.readiness_url",
      "web.chrome_devtools_mcp",
    ]);
    expect(output.checks).toContainEqual({
      code: "web.chrome_devtools_mcp",
      message: "Chrome DevTools MCP listed the target page",
      status: "pass",
    });
    expect(JSON.stringify(output)).not.toContain(projectRoot);
    expect(JSON.stringify(output)).not.toContain(agentsHome);
    expect(await listFiles(projectRoot)).toEqual(beforeProject);
    expect(await listFiles(agentsHome)).toEqual(beforeAgents);
  });

  it("reports the host-supplied optional entry-page observation", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-doctor-project-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-doctor-home-"));
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-doctor-agents-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    await initializeTestProject({
      projectRoot,
      aiQaHome,
      config: {
        ...config,
        targets: { web: { entryUrl: config.targets.web.entryUrl } },
      },
    });
    await installCurrentGlobalSkill(agentsHome);
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: aiQaHome, AI_QA_AGENTS_HOME: agentsHome },
      fetchImpl: vi.fn<typeof fetch>(),
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            entryPage: {
              status: "ready",
              observedAt: "2026-07-13T00:00:00.000Z",
              evidence: "Host observed the configured entry page",
            },
            chromeDevtoolsMcp: {
              status: "ready",
              observedAt: "2026-07-13T00:00:00.000Z",
              evidence: "Host observed Chrome DevTools MCP",
            },
          }),
        ),
    });

    expect(
      await runCli(
        ["doctor", "--platform", "web", "--json", "--stdin-json"],
        captured.context,
      ),
    ).toBe(0);
    const output = JSON.parse(captured.stdout.join("")) as {
      checks: Array<{ code: string; status: string; message: string }>;
    };
    expect(output.checks).toEqual(
      expect.arrayContaining([
        {
          code: "web.entry_page",
          status: "pass",
          message: "Host observed the configured entry page",
        },
        {
          code: "web.chrome_devtools_mcp",
          status: "pass",
          message: "Host observed Chrome DevTools MCP",
        },
      ]),
    );
  });

  it.each(["local-only", "project-skill"] as const)(
    "rejects a legacy global skill for $recordingMode recording",
    async (recordingMode) => {
      const projectRoot = await mkdtemp(
        join(tmpdir(), "ai-qa-doctor-project-"),
      );
      const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-doctor-home-"));
      const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-doctor-agents-"));
      await confirmProjectTrust({
        projectRoot,
        aiQaHome,
        confirmed: true,
        now: new Date("2026-07-13T00:00:00.000Z"),
      });
      await initializeTestProject({
        projectRoot,
        aiQaHome,
        config: {
          ...config,
          recordingPolicy: { mode: recordingMode },
        },
      });
      await installReleasedLegacyGlobalSkill(agentsHome);

      const captured = createCapturedCli({
        cwd: projectRoot,
        env: {
          AI_QA_HOME: aiQaHome,
          AI_QA_AGENTS_HOME: agentsHome,
        },
        fetchImpl: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 204 })),
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({
              chromeDevtoolsMcp: {
                status: "ready",
                observedAt: "2026-07-13T00:00:00.000Z",
                evidence: "Chrome DevTools MCP listed the target page",
              },
            }),
          ),
      });

      expect(
        await runCli(
          ["doctor", "--platform", "web", "--json", "--stdin-json"],
          captured.context,
        ),
      ).toBe(0);
      const output = JSON.parse(captured.stdout.join("")) as {
        status: unknown;
        requiredAction: unknown;
        checks: unknown[];
      };
      expect(output.status).toBe("not_ready");
      expect(output.requiredAction).toBeNull();
      expect(output.checks).toContainEqual({
        code: "agent.global_skill",
        status: "fail",
        message: "Global main Skill status: stale",
      });
    },
  );
});
