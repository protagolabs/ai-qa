import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import type { Platform } from "../../src/core/platforms/schema.js";
import type { RecordingReceiptInput } from "../../src/core/recording/schema.js";

export function projectConfig(
  platforms: readonly Platform[] = ["web"],
  mode: "local-only" | "project-skill" = "local-only",
): ProjectConfig {
  const targets: ProjectConfig["targets"] = {};
  const tools: ProjectConfig["tools"] = {};

  for (const platform of platforms) {
    switch (platform) {
      case "web":
        targets.web = { entryUrl: "http://127.0.0.1:3000" };
        tools.web = { controller: "chrome-devtools-mcp" };
        break;
      case "ios-simulator":
        targets["ios-simulator"] = {
          bundleId: "com.example.sample",
          simulator: { selection: "booted" },
        };
        tools["ios-simulator"] = { controller: "pepper" };
        break;
      case "android-emulator":
        targets["android-emulator"] = {
          appPackage: "com.example.sample",
          appActivity: ".MainActivity",
          emulator: { selection: "running" },
        };
        tools["android-emulator"] = {
          controller: "appium",
          automationName: "uiautomator2",
          endpoint: "http://127.0.0.1:4723",
        };
        break;
    }
  }

  return {
    schemaVersion: 3,
    project: { id: "sample-web", name: "Sample Web" },
    targets,
    environments: {},
    tools,
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
    recordingPolicy: { mode },
    storagePolicy: { adapter: "project-local" },
    gitPolicy: { config: "track", artifacts: "ignore" },
    ciPolicy: { nonPassExit: "failure" },
    secretReferences: { login: "QA_TEST_PASSWORD" },
  };
}

export function projectSkillSource(
  recordingProcedure = "Show the verified local report paths and stop.",
): string {
  return `---
name: ai-qa-project
description: Use when performing Web AI QA for this project.
---

# Project AI QA Procedures

## Result recording

${recordingProcedure}
`;
}

export function projectRecordingReceipt(input: {
  status: RecordingReceiptInput["status"];
  references?: string[];
}): RecordingReceiptInput {
  return {
    status: input.status,
    references: input.references ?? [],
  };
}

export async function initializeTestProject(input: {
  projectRoot: string;
  config?: ProjectConfig;
  projectSkill?: string;
}): Promise<void> {
  await Promise.all([
    mkdir(join(input.projectRoot, ".ai-qa", "cases"), { recursive: true }),
    mkdir(join(input.projectRoot, ".ai-qa", "runs"), { recursive: true }),
    mkdir(join(input.projectRoot, ".ai-qa", "run-groups"), {
      recursive: true,
    }),
    mkdir(join(input.projectRoot, ".ai-qa", "evidence"), { recursive: true }),
    mkdir(join(input.projectRoot, ".ai-qa", "reports", "runs"), {
      recursive: true,
    }),
    mkdir(join(input.projectRoot, ".ai-qa", "reports", "groups"), {
      recursive: true,
    }),
    mkdir(join(input.projectRoot, ".agents", "skills", "ai-qa-project"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(
      join(input.projectRoot, ".ai-qa", "config.yaml"),
      stringify(input.config ?? projectConfig(), { sortMapEntries: true }),
      "utf8",
    ),
    writeFile(
      join(input.projectRoot, ".agents", "skills", "ai-qa-project", "SKILL.md"),
      input.projectSkill ?? projectSkillSource(),
      "utf8",
    ),
  ]);
}
