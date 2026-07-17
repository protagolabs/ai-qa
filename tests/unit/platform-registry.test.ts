import { describe, expect, it } from "vitest";
import {
  configuredPlatforms,
  projectConfigSchema,
  type ProjectConfig,
} from "../../src/core/config/schema.js";
import {
  controllerForPlatform,
  controllerMatchesPlatform,
} from "../../src/core/platforms/registry.js";
import {
  platformSchema,
  type Platform,
} from "../../src/core/platforms/schema.js";
import { projectConfig } from "../helpers/project-fixture.js";

const expectedControllers = {
  web: "chrome-devtools-mcp",
  "ios-simulator": "pepper",
  "android-emulator": "appium",
} as const;

function projectConfigFor(platforms: readonly Platform[]): ProjectConfig {
  return projectConfig(platforms);
}

describe("platform registry", () => {
  it.each(Object.entries(expectedControllers))(
    "%s owns controller %s",
    (platform, controller) => {
      expect(controllerForPlatform(platformSchema.parse(platform))).toBe(
        controller,
      );
    },
  );

  it("matches only the controller owned by a platform", () => {
    expect(controllerMatchesPlatform("ios-simulator", "pepper")).toBe(true);
    expect(controllerMatchesPlatform("ios-simulator", "appium")).toBe(false);
  });

  it.each([
    [["web"]],
    [["ios-simulator"]],
    [["android-emulator"]],
    [["web", "ios-simulator"]],
    [["web", "ios-simulator", "android-emulator"]],
  ] as const)("accepts configured subset %j", (platforms) => {
    expect(
      projectConfigSchema.parse(projectConfigFor(platforms)),
    ).toBeDefined();
  });

  it("rejects empty and target/tool-mismatched platform sets", () => {
    expect(() => projectConfigSchema.parse(projectConfigFor([]))).toThrow();
    const mismatched = projectConfigFor(["web"]);
    mismatched.tools = { "ios-simulator": { controller: "pepper" } };
    expect(() => projectConfigSchema.parse(mismatched)).toThrow();
  });

  it("returns configured platforms in canonical registry order", () => {
    expect(
      configuredPlatforms(
        projectConfigFor(["android-emulator", "web", "ios-simulator"]),
      ),
    ).toEqual(["web", "ios-simulator", "android-emulator"]);
  });
});
