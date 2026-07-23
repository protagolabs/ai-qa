import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/program.js";
import {
  runReportSchema,
  type RunReport,
} from "../../src/core/reports/schema.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import {
  initializeTestProject,
  projectConfig,
} from "../helpers/project-fixture.js";

const reportService = vi.hoisted(() => ({
  exportPaths: vi.fn(),
  generate: vi.fn(),
  withVerified: vi.fn(),
}));

vi.mock("../../src/services/report-generation/generate-run-report.js", () => ({
  exportProjectLocalRunReport: reportService.exportPaths,
  generateRunReport: reportService.generate,
  withVerifiedGeneratedRunReport: reportService.withVerified,
}));

const paths = {
  jsonPath: ".ai-qa/reports/runs/run-ci-report/report.json",
  markdownPath: ".ai-qa/reports/runs/run-ci-report/report.md",
};
let currentReport: RunReport;

function runReport(input: {
  execution: "local" | "ci";
  status?: "completed" | "cancelled";
  verdict: "pass" | "fail";
}): RunReport {
  const status = input.status ?? "completed";
  return runReportSchema.parse({
    schemaVersion: 2,
    generatedAt: "2026-07-17T00:05:00.000Z",
    project: { id: "sample-web", name: "Sample Web" },
    reportPolicy: { audience: "engineering", detail: "full" },
    run: {
      id: "run-ci-report",
      kind: "exploratory",
      execution: input.execution,
      platform: "web",
      controller: "chrome-devtools-mcp",
      status,
    },
    verdict:
      status === "cancelled"
        ? {
            classification: "not_verified",
            summary: "Cancelled by CI",
            criterionResults: [],
            reasonCode: "cancelled",
          }
        : {
            classification: input.verdict,
            summary: "Run verdict",
            criterionResults: [],
          },
    workOrder: {
      goal: "Verify sign-in",
      acceptanceCriteria: [
        {
          id: "sign-in-completes",
          description: "The user reaches the dashboard",
          requiredEvidence: ["post-action-screenshot"],
        },
      ],
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
    },
    evidence: [],
    timeline: [],
    integrity: {
      status: "verified",
      verifiedAt: "2026-07-17T00:05:00.000Z",
    },
  });
}

async function cliFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-cli-exit-"));
  await initializeTestProject({
    projectRoot,
    config: projectConfig(["web"]),
  });
  return createCapturedCli({ cwd: projectRoot });
}

beforeEach(() => {
  reportService.generate.mockReset();
  reportService.exportPaths.mockReset();
  reportService.withVerified.mockReset();
  reportService.generate.mockImplementation(() =>
    Promise.resolve({ report: currentReport, ...paths }),
  );
  reportService.exportPaths.mockImplementation(() => Promise.resolve(paths));
  reportService.withVerified.mockImplementation(
    (_input, operation: (verified: unknown) => Promise<unknown>) =>
      operation({ report: currentReport, paths }),
  );
});

describe("single-run CI report CLI exits", () => {
  it.each([
    ["a failed CI run", { execution: "ci", verdict: "fail" }, 1],
    [
      "a cancelled CI run",
      { execution: "ci", status: "cancelled", verdict: "pass" },
      1,
    ],
    ["a passing CI run", { execution: "ci", verdict: "pass" }, 0],
    ["a failed local run", { execution: "local", verdict: "fail" }, 0],
  ] as const)(
    "applies the expected exit code for %s when generating and exporting",
    async (_scenario, input, expectedExit) => {
      currentReport = runReport(input);

      const generated = await cliFixture();
      expect(
        await runCli(
          ["report", "generate", "run-ci-report"],
          generated.context,
        ),
      ).toBe(expectedExit);
      expect(JSON.parse(generated.stdout.join(""))).toEqual(paths);

      const exported = await cliFixture();
      expect(
        await runCli(
          ["report", "export", "run-ci-report", "--adapter", "project-local"],
          exported.context,
        ),
      ).toBe(expectedExit);
      expect(JSON.parse(exported.stdout.join(""))).toEqual(paths);
    },
  );
});
