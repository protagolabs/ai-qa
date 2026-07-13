import { describe, expect, it, vi } from "vitest";
import { runWebDoctor } from "../../src/services/doctor/web-doctor.js";

describe("runWebDoctor", () => {
  it("is ready only when the configured URL and agent-observed MCP capability are ready", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 200 }));

    const result = await runWebDoctor({
      entryUrl: "http://127.0.0.1:3000",
      readinessUrl: "http://127.0.0.1:3000/health",
      chromeDevtoolsMcp: {
        status: "ready",
        observedAt: "2026-07-13T00:00:00.000Z",
        evidence: "Chrome DevTools MCP listed the target page",
      },
      globalSkillStatus: "compatible",
      fetchImpl,
    });

    expect(result.status).toBe("ready");
    expect(result.checks.map((check) => check.code)).toEqual([
      "web.entry_url",
      "web.readiness_url",
      "web.chrome_devtools_mcp",
      "agent.global_skill",
    ]);
  });

  it("reports missing MCP as a tool readiness failure, not a product verdict", async () => {
    const result = await runWebDoctor({
      entryUrl: "http://127.0.0.1:3000",
      chromeDevtoolsMcp: {
        status: "missing",
        observedAt: "2026-07-13T00:00:00.000Z",
        evidence: "No Chrome DevTools MCP capability was available",
      },
      globalSkillStatus: "compatible",
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
});
