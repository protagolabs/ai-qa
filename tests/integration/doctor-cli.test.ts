import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/program.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { initializeProject } from "../../src/services/initialization/initialize-project.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { createCapturedCli } from "../helpers/cli-context.js";

const config: ProjectConfig = {
  schemaVersion: 1,
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
  secretReferences: {},
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

describe("web doctor CLI", () => {
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
    await initializeProject({ projectRoot, aiQaHome, config });

    const installedSkill = createCapturedCli({
      env: { AI_QA_AGENTS_HOME: agentsHome },
    });
    expect(
      await runCli(["skill", "install", "--global"], installedSkill.context),
    ).toBe(0);

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
    const stateRoot = join(projectRoot, ".ai-qa");
    const before = await listFiles(stateRoot);

    const exitCode = await runCli(
      ["doctor", "--platform", "web", "--json", "--stdin-json"],
      captured.context,
    );

    expect(exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(config.targets.web.readinessUrl);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(captured.stdout.join(""))).toMatchInlineSnapshot(`
      {
        "checks": [
          {
            "code": "web.entry_url",
            "message": "Configured http://127.0.0.1:3000",
            "status": "pass",
          },
          {
            "code": "web.readiness_url",
            "message": "HTTP 204",
            "status": "pass",
          },
          {
            "code": "web.chrome_devtools_mcp",
            "message": "Chrome DevTools MCP listed the target page",
            "status": "pass",
          },
          {
            "code": "agent.global_skill",
            "message": "Global skill status: compatible",
            "status": "pass",
          },
        ],
        "platform": "web",
        "status": "ready",
      }
    `);
    expect(await listFiles(stateRoot)).toEqual(before);
  });
});
