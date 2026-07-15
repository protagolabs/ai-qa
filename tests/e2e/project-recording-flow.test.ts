import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { runCli } from "../../src/cli/program.js";
import type { ProjectConfigV2 } from "../../src/core/config/schema.js";
import {
  recordingArtifactSchema,
  recordingEventSchema,
} from "../../src/core/recording/schema.js";
import { runReportSchema } from "../../src/core/reports/schema.js";
import type { WorkOrder } from "../../src/core/runs/schema.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import {
  projectRecordingReceipt,
  projectSetupRequest,
} from "../helpers/project-fixture.js";

const fixedNow = () => new Date("2026-07-15T09:30:00.000Z");
const receiptTimes = {
  recorded: "2026-07-15T09:31:00.000Z",
  notRecorded: "2026-07-15T09:32:00.000Z",
  unknown: "2026-07-15T09:33:00.000Z",
} as const;
const recordingProcedure = `Append a reviewed row to \`docs/qa-results.md\` using columns Run, Verdict, Summary,
Evidence, and Owner. Match by Run before appending; update the existing row on rerun.
Return only the repository-relative heading reference.`;

interface CliHarness {
  run<T>(args: string[], stdin?: unknown): Promise<T>;
}

interface TestProject {
  projectRoot: string;
  aiQaHome: string;
  cli: CliHarness;
  setNow(value: string): void;
}

interface GeneratedReportPaths {
  jsonPath: string;
  markdownPath: string;
}

interface RecordingStatus {
  runId: string;
  status:
    "pending" | "not_applicable" | "recorded" | "not_recorded" | "unknown";
  references: string[];
  eventId?: string;
  recordedAt?: string;
}

interface StableRunArtifacts {
  jsonBytes: string;
  markdownBytes: string;
  eventBytes: string;
  jsonHash: string;
  markdownHash: string;
  eventHash: string;
  verdict: unknown;
  criterionResults: unknown;
  integrity: unknown;
  terminalEvent: unknown;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function expectCompletePreparedProjectSkill(
  actual: string,
  source: string,
): void {
  const split = (value: string) => {
    const frontmatterEnd = value.indexOf("\n---\n", 4);
    expect(value.startsWith("---\n")).toBe(true);
    expect(frontmatterEnd).toBeGreaterThan(4);
    return {
      frontmatter: parse(value.slice(4, frontmatterEnd)) as {
        metadata: Record<string, unknown>;
        [key: string]: unknown;
      },
      body: value.slice(frontmatterEnd + 5),
    };
  };
  const prepared = split(actual);
  const requested = split(source);
  const managedChecksum = prepared.frontmatter.metadata.aiQaManagedChecksum;
  expect(managedChecksum).toMatch(/^[a-f0-9]{64}$/u);
  expect(prepared.frontmatter).toEqual({
    ...requested.frontmatter,
    metadata: {
      ...requested.frontmatter.metadata,
      aiQaManagedChecksum: managedChecksum,
    },
  });
  expect(prepared.body).toBe(requested.body);
}

function createHarness(input: {
  projectRoot: string;
  machineHome: string;
  aiQaHome: string;
  agentsHome: string;
  now: () => Date;
}): CliHarness {
  return {
    async run<T>(args: string[], stdin?: unknown): Promise<T> {
      const captured = createCapturedCli({
        cwd: input.projectRoot,
        homeDir: input.machineHome,
        env: {
          AI_QA_HOME: input.aiQaHome,
          AI_QA_AGENTS_HOME: input.agentsHome,
        },
        now: input.now,
        fetchImpl: vi.fn<typeof fetch>(),
        readStdin: () =>
          Promise.resolve(stdin === undefined ? "" : JSON.stringify(stdin)),
      });
      const exitCode = await runCli(args, captured.context);
      expect(exitCode, `exit code for: ai-qa ${args.join(" ")}`).toBe(0);
      expect(captured.stderr, `stderr for: ai-qa ${args.join(" ")}`).toEqual(
        [],
      );
      expect(
        captured.stdout,
        `stdout for: ai-qa ${args.join(" ")}`,
      ).toHaveLength(1);
      return JSON.parse(captured.stdout[0]!) as T;
    },
  };
}

async function createTrustedProject(): Promise<TestProject> {
  const machineHome = await mkdtemp(join(tmpdir(), "ai-qa-recording-e2e-"));
  const projectRoot = join(machineHome, "target-project");
  const aiQaHome = join(machineHome, "ai-qa-home");
  const agentsHome = join(machineHome, "agents-home");
  let now = fixedNow();
  await mkdir(projectRoot, { recursive: true });
  const cli = createHarness({
    projectRoot,
    machineHome,
    aiQaHome,
    agentsHome,
    now: () => now,
  });
  await cli.run(["skill", "install", "--global"]);
  await cli.run(
    ["trust", "confirm", "--project", projectRoot, "--stdin-json"],
    { confirmed: true },
  );
  return {
    projectRoot,
    aiQaHome,
    cli,
    setNow(value) {
      now = new Date(value);
    },
  };
}

async function initializeThroughCli(
  fixture: TestProject,
  request: ReturnType<typeof projectSetupRequest>,
): Promise<string> {
  const preview = await fixture.cli.run<{
    checksum: string;
    operation: string;
    writePaths: string[];
    config: ProjectConfigV2;
    projectSkill: { content: string };
  }>(
    ["--project", fixture.projectRoot, "init", "--stdin-json", "--preview"],
    request,
  );
  expect(preview).toMatchObject({
    operation: "init",
    writePaths: [".ai-qa/config.yaml", ".agents/skills/ai-qa-project/SKILL.md"],
    config: request.config,
  });
  expectCompletePreparedProjectSkill(
    preview.projectSkill.content,
    request.projectSkill.content,
  );
  expect(preview.checksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
  await fixture.cli.run(
    [
      "--project",
      fixture.projectRoot,
      "init",
      "--stdin-json",
      "--confirm-checksum",
      preview.checksum,
    ],
    request,
  );
  const installedSkill = await readFile(
    join(fixture.projectRoot, ".agents", "skills", "ai-qa-project", "SKILL.md"),
    "utf8",
  );
  expect(installedSkill).toBe(preview.projectSkill.content);
  return installedSkill;
}

function recordingProcedureFromSkill(skill: string): string {
  const match = skill.match(
    /## Project result recording\n\n([\s\S]*?)\n<!-- ai-qa:managed:end -->/u,
  );
  expect(match).not.toBeNull();
  return match![1]!.trimEnd();
}

async function startAndCancelWebRun(fixture: TestProject): Promise<WorkOrder> {
  const readiness = await fixture.cli.run<WorkOrder["readiness"]>(
    ["doctor", "--platform", "web", "--json", "--stdin-json"],
    {
      entryPage: {
        status: "ready",
        observedAt: fixedNow().toISOString(),
        evidence: "The configured local Web target is available",
      },
      chromeDevtoolsMcp: {
        status: "ready",
        observedAt: fixedNow().toISOString(),
        evidence: "Chrome DevTools MCP capability confirmed",
      },
    },
  );
  const run = await fixture.cli.run<WorkOrder>(
    [
      "run",
      "start",
      "--kind",
      "exploratory",
      "--platform",
      "web",
      "--execution",
      "local",
      "--stdin-json",
    ],
    {
      goal: "Verify the recording lifecycle independently from QA execution",
      acceptanceCriteria: [
        {
          id: "recording-lifecycle-covered",
          description: "The recording lifecycle is covered",
          requiredEvidence: ["post-action-screenshot"],
        },
      ],
      readiness,
    },
  );
  const cancelled = await fixture.cli.run<{
    runId: string;
    status: string;
    verdict: string;
  }>([
    "run",
    "cancel",
    run.runId,
    "--reason",
    "Keep the E2E focused on recording orchestration",
  ]);
  expect(cancelled).toMatchObject({
    runId: run.runId,
    status: "cancelled",
    verdict: "not_verified",
  });
  return run;
}

async function generateReport(
  fixture: TestProject,
  runId: string,
): Promise<GeneratedReportPaths> {
  const report = await fixture.cli.run<GeneratedReportPaths>([
    "report",
    "generate",
    runId,
  ]);
  expect(report).toEqual({
    jsonPath: `.ai-qa/reports/runs/${runId}/report.json`,
    markdownPath: `.ai-qa/reports/runs/${runId}/report.md`,
  });
  return report;
}

async function readStableRunArtifacts(input: {
  projectRoot: string;
  runId: string;
  report: GeneratedReportPaths;
}): Promise<StableRunArtifacts> {
  const jsonBytes = await readFile(
    join(input.projectRoot, input.report.jsonPath),
    "utf8",
  );
  const markdownBytes = await readFile(
    join(input.projectRoot, input.report.markdownPath),
    "utf8",
  );
  const eventBytes = await readFile(
    join(input.projectRoot, ".ai-qa", "runs", input.runId, "events.jsonl"),
    "utf8",
  );
  const parsedReport = runReportSchema.parse(JSON.parse(jsonBytes));
  const eventLines = eventBytes.trimEnd().split("\n");
  return {
    jsonBytes,
    markdownBytes,
    eventBytes,
    jsonHash: sha256(jsonBytes),
    markdownHash: sha256(markdownBytes),
    eventHash: sha256(eventBytes),
    verdict: parsedReport.verdict,
    criterionResults: parsedReport.verdict.criterionResults,
    integrity: parsedReport.integrity,
    terminalEvent: JSON.parse(eventLines.at(-1)!),
  };
}

describe("project recording workflow CLI", () => {
  it("ends a local-only run after verified local reports without recording artifacts", async () => {
    const fixture = await createTrustedProject();
    const request = projectSetupRequest({ mode: "local-only" });
    await initializeThroughCli(fixture, request);

    const installedSkill = await readFile(
      join(
        fixture.projectRoot,
        ".agents",
        "skills",
        "ai-qa-project",
        "SKILL.md",
      ),
      "utf8",
    );
    expect(installedSkill).toContain("# Project AI QA Procedures");
    expect(installedSkill).toContain(
      "No additional project record is required; the verified local report completes the workflow.",
    );

    const run = await startAndCancelWebRun(fixture);
    const report = await generateReport(fixture, run.runId);
    await expect(
      readFile(join(fixture.projectRoot, report.jsonPath), "utf8"),
    ).resolves.toContain('"status": "cancelled"');
    expect(
      await fixture.cli.run<RecordingStatus>([
        "report",
        "recording-status",
        run.runId,
      ]),
    ).toEqual({
      runId: run.runId,
      status: "not_applicable",
      references: [],
    });
    const recordingDirectory = join(
      fixture.projectRoot,
      ".ai-qa",
      "reports",
      "runs",
      run.runId,
    );
    await expect(
      access(join(recordingDirectory, "recording.jsonl")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(recordingDirectory, "recording.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records an arbitrary local procedure as neutral receipts without changing the QA result", async () => {
    const fixture = await createTrustedProject();
    const request = projectSetupRequest({
      mode: "project-skill",
      recordingProcedure,
    });
    const installedSkill = await initializeThroughCli(fixture, request);
    const installedProcedure = recordingProcedureFromSkill(installedSkill);
    expect(installedProcedure).toBe(recordingProcedure);
    const procedureTarget = installedProcedure.match(/`([^`]+)`/u)?.[1];
    expect(procedureTarget).toBe("docs/qa-results.md");
    if (procedureTarget === undefined) {
      throw new Error("Installed recording procedure requires a local target");
    }
    const run = await startAndCancelWebRun(fixture);
    const report = await generateReport(fixture, run.runId);
    expect(
      await fixture.cli.run<RecordingStatus>([
        "report",
        "recording-status",
        run.runId,
      ]),
    ).toEqual({ runId: run.runId, status: "pending", references: [] });

    const targetSegments = procedureTarget.split("/");
    const qaResultsPath = join(fixture.projectRoot, ...targetSegments);
    await mkdir(join(fixture.projectRoot, ...targetSegments.slice(0, -1)), {
      recursive: true,
    });
    await writeFile(
      qaResultsPath,
      `# QA Results\n\n## Run 1\n\n| Run | Verdict | Summary | Evidence | Owner |\n| --- | --- | --- | --- | --- |\n| ${run.runId} | not_verified | Run cancelled after lifecycle coverage | ${report.jsonPath} | QA |\n`,
    );
    const reference = `${procedureTarget}#run-1`;
    const before = await readStableRunArtifacts({
      projectRoot: fixture.projectRoot,
      runId: run.runId,
      report,
    });

    fixture.setNow(receiptTimes.recorded);
    const recorded = await fixture.cli.run<{
      eventId: string;
      status: string;
      references: string[];
      replayed: boolean;
    }>(
      ["report", "receipt", run.runId, "--stdin-json"],
      projectRecordingReceipt({
        idempotencyKey: "local-markdown-run-1",
        status: "recorded",
        references: [reference],
      }),
    );
    expect(recorded).toMatchObject({
      status: "recorded",
      references: [reference],
      replayed: false,
    });
    expect(
      await fixture.cli.run<RecordingStatus>([
        "report",
        "recording-status",
        run.runId,
      ]),
    ).toMatchObject({
      runId: run.runId,
      status: "recorded",
      references: [reference],
      eventId: recorded.eventId,
      recordedAt: receiptTimes.recorded,
    });

    fixture.setNow(receiptTimes.notRecorded);
    await fixture.cli.run(
      ["report", "receipt", run.runId, "--stdin-json"],
      projectRecordingReceipt({
        idempotencyKey: "local-markdown-not-recorded",
        status: "not_recorded",
      }),
    );
    expect(
      await fixture.cli.run<RecordingStatus>([
        "report",
        "recording-status",
        run.runId,
      ]),
    ).toMatchObject({
      status: "not_recorded",
      references: [],
      recordedAt: receiptTimes.notRecorded,
    });
    expect(
      await readStableRunArtifacts({
        projectRoot: fixture.projectRoot,
        runId: run.runId,
        report,
      }),
    ).toEqual(before);

    fixture.setNow(receiptTimes.unknown);
    await fixture.cli.run(
      ["report", "receipt", run.runId, "--stdin-json"],
      projectRecordingReceipt({
        idempotencyKey: "local-markdown-unknown",
        status: "unknown",
      }),
    );
    expect(
      await fixture.cli.run<RecordingStatus>([
        "report",
        "recording-status",
        run.runId,
      ]),
    ).toMatchObject({
      status: "unknown",
      references: [],
      recordedAt: receiptTimes.unknown,
    });
    expect(
      await readStableRunArtifacts({
        projectRoot: fixture.projectRoot,
        runId: run.runId,
        report,
      }),
    ).toEqual(before);

    const reportDirectory = join(
      fixture.projectRoot,
      ".ai-qa",
      "reports",
      "runs",
      run.runId,
    );
    const journalBytes = await readFile(
      join(reportDirectory, "recording.jsonl"),
      "utf8",
    );
    const journal = journalBytes
      .trimEnd()
      .split("\n")
      .map((line) => recordingEventSchema.parse(JSON.parse(line)));
    for (const event of journal) {
      expect(Object.keys(event).sort()).toEqual([
        "eventId",
        "idempotencyKey",
        "recordedAt",
        "references",
        "runId",
        "schemaVersion",
        "status",
      ]);
    }
    const materializedBytes = await readFile(
      join(reportDirectory, "recording.json"),
      "utf8",
    );
    const materialized = recordingArtifactSchema.parse(
      JSON.parse(materializedBytes),
    );
    expect(Object.keys(materialized).sort()).toEqual([
      "current",
      "history",
      "materializedAt",
      "runId",
      "schemaVersion",
    ]);
    expect(Object.keys(materialized.current).sort()).toEqual([
      "eventId",
      "references",
      "status",
    ]);
    for (const event of materialized.history) {
      expect(Object.keys(event).sort()).toEqual([
        "eventId",
        "idempotencyKey",
        "recordedAt",
        "references",
        "status",
      ]);
    }
    const expectedHistory = journal.map(
      ({ eventId, recordedAt, idempotencyKey, status, references }) => ({
        eventId,
        recordedAt,
        idempotencyKey,
        status,
        references,
      }),
    );
    expect(
      journal.map(({ status, references }) => ({ status, references })),
    ).toEqual([
      { status: "recorded", references: [reference] },
      { status: "not_recorded", references: [] },
      { status: "unknown", references: [] },
    ]);
    expect(materialized.history).toEqual(expectedHistory);
    expect(journal.map((event) => event.recordedAt)).toEqual([
      receiptTimes.recorded,
      receiptTimes.notRecorded,
      receiptTimes.unknown,
    ]);
    expect(materialized.materializedAt).toBe(journal.at(-1)!.recordedAt);
    expect(materialized.materializedAt).not.toBe(journal[0]!.recordedAt);
    expect(materialized.current).toEqual({
      eventId: journal.at(-1)!.eventId,
      status: journal.at(-1)!.status,
      references: journal.at(-1)!.references,
    });
    expect(await readFile(qaResultsPath, "utf8")).toContain(
      `| ${run.runId} | not_verified |`,
    );

    const configBytes = await readFile(
      join(fixture.projectRoot, ".ai-qa", "config.yaml"),
      "utf8",
    );
    const storedConfig = parse(configBytes) as ProjectConfigV2;
    expect(storedConfig).toEqual(request.config);
    expect(storedConfig.recordingPolicy).toEqual({ mode: "project-skill" });
    expect(Object.keys(storedConfig.recordingPolicy)).toEqual(["mode"]);
  });
});
