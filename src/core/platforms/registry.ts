import { z } from "zod";
import type { Controller, Platform } from "./schema.js";

export const PLATFORM_CONTROLLERS = {
  web: "chrome-devtools-mcp",
  "ios-simulator": "pepper",
  "android-emulator": "appium",
} as const satisfies Record<Platform, Controller>;

export function controllerForPlatform(platform: Platform): Controller {
  return PLATFORM_CONTROLLERS[platform];
}

export function controllerMatchesPlatform(
  platform: Platform,
  controller: Controller,
): boolean {
  return controllerForPlatform(platform) === controller;
}

export const targetSchemas = {
  web: z
    .object({
      entryUrl: z.string().url(),
      readinessUrl: z.string().url().optional(),
    })
    .strict(),
  "ios-simulator": z
    .object({
      bundleId: z.string().trim().min(1),
      simulator: z.discriminatedUnion("selection", [
        z.object({ selection: z.literal("booted") }).strict(),
        z
          .object({
            selection: z.literal("device-name"),
            deviceName: z.string().trim().min(1),
          })
          .strict(),
      ]),
      launch: z
        .object({
          buildCommand: z.string().trim().min(1).optional(),
          arguments: z.array(z.string()).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  "android-emulator": z
    .object({
      appPackage: z.string().trim().min(1),
      appActivity: z.string().trim().min(1),
      emulator: z.discriminatedUnion("selection", [
        z.object({ selection: z.literal("running") }).strict(),
        z
          .object({
            selection: z.literal("avd-name"),
            avdName: z.string().trim().min(1),
          })
          .strict(),
      ]),
    })
    .strict(),
} as const;

export const toolSchemas = {
  web: z.object({ controller: z.literal("chrome-devtools-mcp") }).strict(),
  "ios-simulator": z.object({ controller: z.literal("pepper") }).strict(),
  "android-emulator": z
    .object({
      controller: z.literal("appium"),
      automationName: z.literal("uiautomator2"),
      endpoint: z.string().url(),
    })
    .strict(),
} as const;
