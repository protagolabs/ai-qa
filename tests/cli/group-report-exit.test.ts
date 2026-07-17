import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/program.js";
import {
  runGroupReportSchema,
  type RunGroupReport,
  type RunGroupReportCell,
} from "../../src/core/reports/group-schema.js";
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

vi.mock(
  "../../src/services/report-generation/generate-group-report.js",
  () => ({
    exportProjectLocalGroupReport: reportService.exportPaths,
    generateRunGroupReport: reportService.generate,
    withVerifiedGeneratedRunGroupReport: reportService.withVerified,
  }),
);

const paths = {
  jsonPath: ".ai-qa/reports/groups/run-group-ci-report/report.json",
  markdownPath: ".ai-qa/reports/groups/run-group-ci-report/report.md",
};
let currentReport: RunGroupReport;

function reportCell(status: RunGroupReportCell["status"]): RunGroupReportCell {
  const identity = {
    caseId: "login",
    revision: 1,
    caseContentHash: `sha256:${"0".repeat(64)}`,
    platform: "web" as const,
  };
  switch (status) {
    case "pass":
    case "fail":
      return { ...identity, runId: "run-login-web", status };
    case "blocked":
      return {
        ...identity,
        runId: "run-login-web",
        status,
        blockerSubtype: "tool",
      };
    case "not_verified":
      return {
        ...identity,
        runId: "run-login-web",
        status,
        reasonCode: "cancelled",
      };
    case "coverage_gap":
      return { ...identity, status, reason: "missing_variant" };
  }
}

function groupReport(input: {
  execution: "local" | "ci";
  groupStatus?: "completed" | "cancelled";
  cellStatus: RunGroupReportCell["status"];
}): RunGroupReport {
  const cell = reportCell(input.cellStatus);
  return runGroupReportSchema.parse({
    schemaVersion: 2,
    generatedAt: "2026-07-17T00:05:00.000Z",
    project: { id: "sample-web", name: "Sample Web" },
    reportPolicy: { audience: "engineering", detail: "full" },
    group: {
      id: "run-group-ci-report",
      execution: input.execution,
      status: input.groupStatus ?? "completed",
      selectionMode: "explicit",
      selectedPlatforms: ["web"],
      createdAt: "2026-07-17T00:00:00.000Z",
    },
    matrix: [cell],
    summary: {
      pass: input.cellStatus === "pass" ? 1 : 0,
      fail: input.cellStatus === "fail" ? 1 : 0,
      blocked: input.cellStatus === "blocked" ? 1 : 0,
      notVerified: input.cellStatus === "not_verified" ? 1 : 0,
      coverageGap: input.cellStatus === "coverage_gap" ? 1 : 0,
    },
    integrity: {
      status: "verified",
      verifiedAt: "2026-07-17T00:05:00.000Z",
    },
  });
}

async function cliFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-group-cli-exit-"));
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

describe("CI aggregate report CLI exits", () => {
  it("returns zero for a completed all-pass CI group", async () => {
    currentReport = groupReport({ execution: "ci", cellStatus: "pass" });
    const captured = await cliFixture();

    expect(
      await runCli(
        ["report", "group-generate", "run-group-ci-report"],
        captured.context,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(""))).toEqual(paths);
  });

  it.each(["fail", "blocked", "not_verified", "coverage_gap"] as const)(
    "returns one for a CI group containing a %s cell",
    async (cellStatus) => {
      currentReport = groupReport({ execution: "ci", cellStatus });
      const captured = await cliFixture();

      expect(
        await runCli(
          ["report", "group-generate", "run-group-ci-report"],
          captured.context,
        ),
      ).toBe(1);
      expect(JSON.parse(captured.stdout.join(""))).toEqual(paths);
    },
  );

  it("returns one for a non-completed CI group even when every cell passes", async () => {
    currentReport = groupReport({
      execution: "ci",
      groupStatus: "cancelled",
      cellStatus: "pass",
    });
    const captured = await cliFixture();

    expect(
      await runCli(
        ["report", "group-generate", "run-group-ci-report"],
        captured.context,
      ),
    ).toBe(1);
    expect(JSON.parse(captured.stdout.join(""))).toEqual(paths);
  });

  it("keeps a local non-pass aggregate at exit zero", async () => {
    currentReport = groupReport({ execution: "local", cellStatus: "fail" });
    const captured = await cliFixture();

    expect(
      await runCli(
        ["report", "group-generate", "run-group-ci-report"],
        captured.context,
      ),
    ).toBe(0);
  });

  it.each([
    ["pass", 0],
    ["fail", 1],
  ] as const)(
    "applies the same CI policy to group export for a %s cell",
    async (cellStatus, expectedExit) => {
      currentReport = groupReport({ execution: "ci", cellStatus });
      const captured = await cliFixture();

      expect(
        await runCli(
          [
            "report",
            "group-export",
            "run-group-ci-report",
            "--adapter",
            "project-local",
          ],
          captured.context,
        ),
      ).toBe(expectedExit);
      expect(JSON.parse(captured.stdout.join(""))).toEqual(paths);
      expect(reportService.withVerified).toHaveBeenCalledOnce();
    },
  );
});
