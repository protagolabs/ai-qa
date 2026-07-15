import type {
  ProjectConfigV1,
  ProjectConfigV2,
} from "../../src/core/config/schema.js";
import {
  applyProjectSetup,
  previewProjectSetup,
} from "../../src/services/initialization/initialize-project.js";

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
  recordingProcedure: string = "No additional project record is required; the verified local report completes the workflow.",
): string {
  return `---
name: ai-qa-project
description: Use when performing AI QA work in this target project, including startup, authentication, evidence, reports, or result recording.
metadata:
  aiQaProjectSkillVersion: 1.0.0
  aiQaProtocolRange: ^1.1.0
  aiQaManagedChecksum: generated
---
<!-- ai-qa:managed:start -->
# Project AI QA Procedures

## Startup and environment

Run the existing local development command documented by the project.

## Authentication and test data

Read credentials only from \${QA_TEST_PASSWORD}; never persist the value.

## Navigation and platform constraints

Start at the configured Web entry URL and prefer stable test IDs.

## Evidence, privacy, and reports

Follow config sensitivity, retention, and local report policy.

## Project result recording

${recordingProcedure}
<!-- ai-qa:managed:end -->
<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
`;
}

export async function initializeTestProject(input: {
  projectRoot: string;
  aiQaHome: string;
  config?: ProjectConfigV2;
}): Promise<void> {
  const request = {
    config: input.config ?? projectConfigV2(),
    projectSkill: {
      reason: "Test fixture project procedures",
      content: projectSkillSource(),
    },
  };
  const preview = await previewProjectSetup({
    operation: "init",
    projectRoot: input.projectRoot,
    aiQaHome: input.aiQaHome,
    request,
  });
  await applyProjectSetup({
    operation: "init",
    projectRoot: input.projectRoot,
    aiQaHome: input.aiQaHome,
    request,
    confirmChecksum: preview.checksum,
  });
}
