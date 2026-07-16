import { describe, expect, it, vi } from "vitest";
import { runWebDoctor } from "../../src/services/doctor/web-doctor.js";

describe("runWebDoctor", () => {
  it("is ready only when the configured URL and agent-observed MCP capability are ready", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 200 }));

    const result = await runWebDoctor({
      installationChecks: [
        {
          code: "project.config",
          status: "pass",
          message: "Configuration .ai-qa/config.yaml is readable",
        },
      ],
      entryUrl: "http://127.0.0.1:3000",
      readinessUrl: "http://127.0.0.1:3000/health",
      chromeDevtoolsMcp: {
        status: "ready",
        observedAt: "2026-07-13T00:00:00.000Z",
        evidence: "Chrome DevTools MCP listed the target page",
      },
      fetchImpl,
    });

    expect(result.status).toBe("ready");
    expect(result.checks.map((check) => check.code)).toEqual([
      "project.config",
      "web.entry_url",
      "web.readiness_url",
      "web.chrome_devtools_mcp",
    ]);
  });

  it("reports missing MCP as a tool readiness failure, not a product verdict", async () => {
    const result = await runWebDoctor({
      installationChecks: [],
      entryUrl: "http://127.0.0.1:3000",
      chromeDevtoolsMcp: {
        status: "missing",
        observedAt: "2026-07-13T00:00:00.000Z",
        evidence: "No Chrome DevTools MCP capability was available",
      },
      fetchImpl: vi.fn<typeof fetch>(),
    });

    expect(result.status).toBe("not_ready");
    expect(
      result.checks.find((check) => check.code === "web.chrome_devtools_mcp"),
    ).toMatchObject({
      status: "fail",
    });
    expect(result).not.toHaveProperty("verdict");
  });

  it("keeps installation advisories visible without blocking Web readiness", async () => {
    const result = await runWebDoctor({
      installationChecks: [
        {
          code: "agent.project_skill",
          status: "advisory",
          message: "Legacy config has no .agents/skills/ai-qa-project/SKILL.md",
        },
      ],
      entryUrl: "http://127.0.0.1:3000",
      entryPage: {
        status: "ready",
        observedAt: "2026-07-13T00:00:00.000Z",
        evidence: "The supplied entry-page observation is ready",
      },
      chromeDevtoolsMcp: {
        status: "ready",
        observedAt: "2026-07-13T00:00:00.000Z",
        evidence: "Chrome DevTools MCP is available",
      },
      fetchImpl: vi.fn<typeof fetch>(),
    });

    expect(result.status).toBe("ready");
    expect(result.checks[0]).toEqual({
      code: "agent.project_skill",
      status: "pass",
      message: "Legacy config has no .agents/skills/ai-qa-project/SKILL.md",
    });
  });
});
