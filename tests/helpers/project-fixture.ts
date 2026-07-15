import type {
  ProjectConfigV1,
  ProjectConfigV2,
} from "../../src/core/config/schema.js";

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
