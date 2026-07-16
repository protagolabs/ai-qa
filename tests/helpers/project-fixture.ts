import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import type {
  ProjectConfigV1,
  ProjectConfigV2,
} from "../../src/core/config/schema.js";
import type { RecordingReceiptInput } from "../../src/core/recording/schema.js";

function projectFields() {
  return {
    project: { id: "sample-web", name: "Sample Web" },
    targets: { web: { entryUrl: "http://127.0.0.1:3000" } },
    environments: {},
    tools: { web: { controller: "chrome-devtools-mcp" as const } },
    evidencePolicy: {
      screenshots: "required" as const,
      defaultSensitivity: "internal" as const,
      retentionDays: 30,
    },
    reportPolicy: {
      formats: ["markdown", "json"] as ("markdown" | "json")[],
      audience: "engineering",
      detail: "full" as const,
    },
    storagePolicy: { adapter: "project-local" as const },
    gitPolicy: { config: "track" as const, artifacts: "ignore" as const },
    ciPolicy: { nonPassExit: "failure" as const },
    secretReferences: { login: "QA_TEST_PASSWORD" },
  };
}

export function projectConfigV1(): ProjectConfigV1 {
  return { schemaVersion: 1, ...projectFields() };
}

export function projectConfigV2(
  mode: "local-only" | "project-skill" = "local-only",
): ProjectConfigV2 {
  return {
    schemaVersion: 2,
    ...projectFields(),
    recordingPolicy: { mode },
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
  aiQaHome: string;
  config?: ProjectConfigV2;
  projectSkill?: string;
}): Promise<void> {
  await Promise.all([
    mkdir(join(input.projectRoot, ".ai-qa", "cases"), { recursive: true }),
    mkdir(join(input.projectRoot, ".ai-qa", "runs"), { recursive: true }),
    mkdir(join(input.projectRoot, ".ai-qa", "evidence"), { recursive: true }),
    mkdir(join(input.projectRoot, ".ai-qa", "reports", "runs"), {
      recursive: true,
    }),
    mkdir(join(input.projectRoot, ".agents", "skills", "ai-qa-project"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(
      join(input.projectRoot, ".ai-qa", "config.yaml"),
      stringify(input.config ?? projectConfigV2(), { sortMapEntries: true }),
      "utf8",
    ),
    writeFile(
      join(input.projectRoot, ".agents", "skills", "ai-qa-project", "SKILL.md"),
      input.projectSkill ?? projectSkillSource(),
      "utf8",
    ),
  ]);
}
