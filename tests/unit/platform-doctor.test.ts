import { describe, expect, it, vi } from "vitest";
import { runPlatformDoctor } from "../../src/services/doctor/platform-doctor.js";

const ready = (evidence: string) => ({
  status: "ready" as const,
  observedAt: "2026-07-17T00:00:00.000Z",
  evidence,
});

const iosTarget = {
  bundleId: "com.example.app",
  simulator: {
    selection: "device-name" as const,
    deviceName: "iPhone 16 Pro",
  },
};

const androidTarget = {
  appPackage: "com.example.app",
  appActivity: ".MainActivity",
  emulator: { selection: "avd-name" as const, avdName: "Pixel_9_API_36" },
};

const androidTool = {
  controller: "appium" as const,
  automationName: "uiautomator2" as const,
  endpoint: "http://127.0.0.1:4723",
};

describe("runPlatformDoctor", () => {
  it("reports Web ready when its URL and controller checks pass", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 200 }));

    const result = await runPlatformDoctor({
      platform: "web",
      target: {
        entryUrl: "http://127.0.0.1:3000",
        readinessUrl: "http://127.0.0.1:3000/health",
      },
      installationChecks: [
        {
          code: "project.config",
          status: "pass",
          message: "Configuration .ai-qa/config.yaml is readable",
        },
      ],
      observations: {
        chromeDevtoolsMcp: ready("Chrome DevTools MCP listed the target page"),
      },
      fetchImpl,
    });

    expect(result).toMatchObject({ platform: "web", status: "ready" });
    expect(result.checks).toEqual([
      {
        code: "project.config",
        status: "pass",
        message: "Configuration .ai-qa/config.yaml is readable",
        category: "installation",
      },
      {
        code: "web.entry_url",
        status: "pass",
        message: "Configured http://127.0.0.1:3000",
        category: "environment",
      },
      {
        code: "web.readiness_url",
        status: "pass",
        message: "HTTP 200",
        category: "environment",
      },
      {
        code: "web.chrome_devtools_mcp",
        status: "pass",
        message: "Chrome DevTools MCP listed the target page",
        category: "tool",
      },
    ]);
  });

  it("reports a missing Web controller without producing a product verdict", async () => {
    const result = await runPlatformDoctor({
      platform: "web",
      target: { entryUrl: "http://127.0.0.1:3000" },
      installationChecks: [],
      observations: {
        entryPage: ready("The configured entry page is available"),
        chromeDevtoolsMcp: {
          ...ready("No Chrome DevTools MCP capability was available"),
          status: "missing",
        },
      },
      fetchImpl: vi.fn<typeof fetch>(),
    });

    expect(result).toMatchObject({ platform: "web", status: "not_ready" });
    expect(result.checks.at(-1)).toMatchObject({
      code: "web.chrome_devtools_mcp",
      status: "fail",
      category: "tool",
    });
    expect(result).not.toHaveProperty("verdict");
  });

  it("keeps installation advisories visible without blocking readiness", async () => {
    const result = await runPlatformDoctor({
      platform: "web",
      target: { entryUrl: "http://127.0.0.1:3000" },
      installationChecks: [
        {
          code: "agent.project_skill",
          status: "advisory",
          message: "Legacy config has no project Skill",
        },
      ],
      observations: {
        entryPage: ready("The configured entry page is available"),
        chromeDevtoolsMcp: ready("Chrome DevTools MCP is available"),
      },
      fetchImpl: vi.fn<typeof fetch>(),
    });

    expect(result.status).toBe("ready");
    expect(result.checks[0]).toEqual({
      code: "agent.project_skill",
      status: "pass",
      message: "Legacy config has no project Skill",
      category: "installation",
    });
  });

  it("reports iOS Simulator ready from host-supplied observations", async () => {
    expect(
      await runPlatformDoctor({
        platform: "ios-simulator",
        target: iosTarget,
        installationChecks: [],
        observations: {
          simulator: ready("iPhone 16 Pro is booted"),
          app: ready("com.example.app is installed and launchable"),
          pepper: ready(
            "Pepper UI and screenshot capabilities are available",
          ),
        },
        fetchImpl: fetch,
      }),
    ).toMatchObject({ platform: "ios-simulator", status: "ready" });
  });

  it("reports iOS Simulator not ready when Pepper is missing", async () => {
    const result = await runPlatformDoctor({
      platform: "ios-simulator",
      target: iosTarget,
      installationChecks: [],
      observations: {
        simulator: ready("iPhone 16 Pro is booted"),
        app: ready("com.example.app is installed and launchable"),
        pepper: { ...ready("Pepper is unavailable"), status: "missing" },
      },
      fetchImpl: fetch,
    });

    expect(result).toMatchObject({
      platform: "ios-simulator",
      status: "not_ready",
    });
    expect(result.checks.at(-1)).toMatchObject({
      code: "ios.pepper",
      status: "fail",
      category: "tool",
    });
  });

  it("reports Android Emulator ready from host-supplied observations", async () => {
    const result = await runPlatformDoctor({
      platform: "android-emulator",
      target: androidTarget,
      tool: androidTool,
      installationChecks: [],
      observations: {
        emulator: ready("Pixel_9_API_36 is running"),
        app: ready("package/activity are launchable"),
        appium: ready("Appium is available"),
        uiautomator2: ready("driver capability is installed"),
      },
      fetchImpl: fetch,
    });

    expect(result).toMatchObject({
      platform: "android-emulator",
      status: "ready",
    });
  });

  it("reports Android Emulator not ready when Appium is missing", async () => {
    expect(
      await runPlatformDoctor({
        platform: "android-emulator",
        target: androidTarget,
        tool: androidTool,
        installationChecks: [],
        observations: {
          emulator: ready("Pixel_9_API_36 is running"),
          app: ready("package/activity are launchable"),
          appium: { ...ready("missing"), status: "missing" },
          uiautomator2: ready("driver capability is installed"),
        },
        fetchImpl: fetch,
      }),
    ).toMatchObject({ platform: "android-emulator", status: "not_ready" });
  });
});
