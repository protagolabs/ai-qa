import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
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
  initializeTestProject,
  projectConfigV2,
  projectRecordingReceipt,
  projectSkillSource,
} from "../helpers/project-fixture.js";

const fixedNow = () => new Date("2026-07-16T09:30:00.000Z");
const recordedAt = "2026-07-16T09:31:00.000Z";
const replayedAt = "2026-07-16T09:32:00.000Z";
const recordingProcedure = `Append a reviewed row to \`docs/qa-results.md\` using columns Run, Verdict, Summary,
Evidence, and Owner. Match by Run before appending; update the existing row on rerun.
Return only the repository-relative heading reference.`;

interface CliError {
  error: { code: string; message: string; details?: unknown };
}

interface CliHarness {
  run<T>(args: string[], stdin?: unknown): Promise<T>;
  runError(args: string[], stdin?: unknown): Promise<CliError>;
}

interface TestProject {
  projectRoot: string;
  cli: CliHarness;
  setNow(value: string): void;
}

interface GeneratedReportPaths {
  jsonPath: string;
  markdownPath: string;
}

interface RecordingStatus {
  subject: { kind: "run"; id: string };
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
  verdict: unknown;
}

function contentSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createHarness(input: {
  projectRoot: string;
  machineHome: string;
  agentsHome: string;
  now: () => Date;
}): CliHarness {
  const execute = async (args: string[], stdin?: unknown) => {
    const captured = createCapturedCli({
      cwd: input.projectRoot,
      homeDir: input.machineHome,
      env: {
        AI_QA_AGENTS_HOME: input.agentsHome,
      },
      now: input.now,
      fetchImpl: vi.fn<typeof fetch>(),
      readStdin: () =>
        Promise.resolve(stdin === undefined ? "" : JSON.stringify(stdin)),
    });
    const exitCode = await runCli(args, captured.context);
    return { exitCode, stdout: captured.stdout, stderr: captured.stderr };
  };
  return {
    async run<T>(args: string[], stdin?: unknown): Promise<T> {
      const result = await execute(args, stdin);
      expect(result.exitCode, `exit code for: ai-qa ${args.join(" ")}`).toBe(0);
      expect(result.stderr, `stderr for: ai-qa ${args.join(" ")}`).toEqual([]);
      expect(result.stdout, `stdout for: ai-qa ${args.join(" ")}`).toHaveLength(
        1,
      );
      return JSON.parse(result.stdout[0]!) as T;
    },
    async runError(args: string[], stdin?: unknown): Promise<CliError> {
      const result = await execute(args, stdin);
      expect(result.exitCode, `exit code for: ai-qa ${args.join(" ")}`).toBe(1);
      expect(result.stdout, `stdout for: ai-qa ${args.join(" ")}`).toEqual([]);
      expect(result.stderr, `stderr for: ai-qa ${args.join(" ")}`).toHaveLength(
        1,
      );
      return JSON.parse(result.stderr[0]!) as CliError;
    },
  };
}

async function createProject(): Promise<TestProject> {
  const machineHome = await mkdtemp(join(tmpdir(), "ai-qa-recording-e2e-"));
  const projectRoot = join(machineHome, "target-project");
  const agentsHome = join(machineHome, "agents-home");
  let now = fixedNow();
  await mkdir(projectRoot, { recursive: true });
  const cli = createHarness({
    projectRoot,
    machineHome,
    agentsHome,
    now: () => now,
  });
  await cli.run(["skill", "install", "--global"]);
  return {
    projectRoot,
    cli,
    setNow(value) {
      now = new Date(value);
    },
  };
}

async function installHostManagedProject(input: {
  fixture: TestProject;
  mode: "local-only" | "project-skill";
  procedure?: string;
}): Promise<{ config: ProjectConfigV2; skill: string }> {
  const config = projectConfigV2(input.mode);
  const skill = projectSkillSource(input.procedure);
  await expect(
    input.fixture.cli.run(["config", "validate", "--stdin-json"], config),
  ).resolves.toEqual({ status: "valid", config });
  await initializeTestProject({
    projectRoot: input.fixture.projectRoot,
    config,
    projectSkill: skill,
  });
  const installedSkill = await readFile(
    join(
      input.fixture.projectRoot,
      ".agents",
      "skills",
      "ai-qa-project",
      "SKILL.md",
    ),
    "utf8",
  );
  expect(installedSkill).toBe(skill);
  expect(installedSkill).not.toContain("aiQaManagedChecksum");
  return { config, skill };
}

function recordingProcedureFromSkill(skill: string): string {
  const match = skill.match(/## Result recording\n\n([\s\S]*?)\n?$/u);
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
      goal: "Verify recording without changing the QA verdict",
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
  expect(run.readiness).not.toHaveProperty("requiredAction");
  await fixture.cli.run([
    "run",
    "cancel",
    run.runId,
    "--reason",
    "Keep the E2E focused on recording orchestration",
  ]);
  return run;
}

async function generateReport(
  fixture: TestProject,
  runId: string,
): Promise<GeneratedReportPaths> {
  return fixture.cli.run(["report", "generate", runId]);
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
  return {
    jsonBytes,
    markdownBytes,
    eventBytes,
    verdict: runReportSchema.parse(JSON.parse(jsonBytes)).verdict,
  };
}

async function switchMode(
  fixture: TestProject,
  mode: "local-only" | "project-skill",
): Promise<void> {
  const config = projectConfigV2(mode);
  await expect(
    fixture.cli.run(["config", "validate", "--stdin-json"], config),
  ).resolves.toEqual({ status: "valid", config });
  await writeFile(
    join(fixture.projectRoot, ".ai-qa", "config.yaml"),
    stringify(config, { sortMapEntries: true }),
  );
}

describe("project recording workflow CLI", () => {
  it("ends a local-only run after verified local reports without recording files", async () => {
    const fixture = await createProject();
    await installHostManagedProject({ fixture, mode: "local-only" });
    const run = await startAndCancelWebRun(fixture);
    const report = await generateReport(fixture, run.runId);
    await expect(
      readFile(join(fixture.projectRoot, report.jsonPath), "utf8"),
    ).resolves.toContain('"status": "cancelled"');

    const status = await fixture.cli.run<RecordingStatus>([
      "report",
      "recording-status",
      run.runId,
    ]);
    expect(status).toEqual({
      subject: { kind: "run", id: run.runId },
      status: "not_applicable",
      references: [],
    });
    const reportDirectory = join(
      fixture.projectRoot,
      ".ai-qa",
      "reports",
      "runs",
      run.runId,
    );
    await expect(
      access(join(reportDirectory, "recording.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(reportDirectory, "recording.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes an exact arbitrary project procedure and stores one keyless idempotent neutral receipt", async () => {
    const fixture = await createProject();
    const installed = await installHostManagedProject({
      fixture,
      mode: "project-skill",
      procedure: recordingProcedure,
    });
    const installedProcedure = recordingProcedureFromSkill(installed.skill);
    expect(installedProcedure).toBe(recordingProcedure);
    const procedureTarget = installedProcedure.match(/`([^`]+)`/u)?.[1];
    expect(procedureTarget).toBe("docs/qa-results.md");
    if (procedureTarget === undefined) {
      throw new Error("Project recording procedure requires a local target");
    }

    const run = await startAndCancelWebRun(fixture);
    expect(run.projectSkill).toEqual({
      path: ".agents/skills/ai-qa-project/SKILL.md",
      contentSha256: contentSha256(installed.skill),
    });
    const report = await generateReport(fixture, run.runId);
    expect(
      await fixture.cli.run<RecordingStatus>([
        "report",
        "recording-status",
        run.runId,
      ]),
    ).toEqual({
      subject: { kind: "run", id: run.runId },
      status: "pending",
      references: [],
    });

    const qaResultsPath = join(fixture.projectRoot, procedureTarget);
    await mkdir(join(fixture.projectRoot, "docs"), { recursive: true });
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
    const receipt = projectRecordingReceipt({
      status: "recorded",
      references: [reference],
    });

    fixture.setNow(recordedAt);
    const recorded = await fixture.cli.run<{
      eventId: string;
      status: string;
      references: string[];
      replayed: boolean;
    }>(["report", "receipt", run.runId, "--stdin-json"], receipt);
    expect(recorded).toMatchObject({
      status: "recorded",
      references: [reference],
      replayed: false,
    });

    fixture.setNow(replayedAt);
    await expect(
      fixture.cli.run(
        ["report", "receipt", run.runId, "--stdin-json"],
        receipt,
      ),
    ).resolves.toEqual({ ...recorded, replayed: true });
    expect(
      await fixture.cli.run<RecordingStatus>([
        "report",
        "recording-status",
        run.runId,
      ]),
    ).toEqual({
      subject: { kind: "run", id: run.runId },
      status: "recorded",
      references: [reference],
      eventId: recorded.eventId,
      recordedAt,
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
    const journal = (
      await readFile(join(reportDirectory, "recording.jsonl"), "utf8")
    )
      .trimEnd()
      .split("\n")
      .map((line) => recordingEventSchema.parse(JSON.parse(line)));
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      subject: { kind: "run", id: run.runId },
      status: "recorded",
      references: [reference],
      recordedAt,
      idempotencyKey: expect.stringMatching(
        /^recording:sha256:[a-f0-9]{64}:v2$/u,
      ),
    });
    const materialized = recordingArtifactSchema.parse(
      JSON.parse(
        await readFile(join(reportDirectory, "recording.json"), "utf8"),
      ),
    );
    expect(materialized.history).toHaveLength(1);
    expect(materialized.current).toEqual({
      eventId: recorded.eventId,
      status: "recorded",
      references: [reference],
    });
    expect(await readFile(qaResultsPath, "utf8")).toContain(
      `| ${run.runId} | not_verified |`,
    );
    const storedConfig = parse(
      await readFile(
        join(fixture.projectRoot, ".ai-qa", "config.yaml"),
        "utf8",
      ),
    ) as ProjectConfigV2;
    expect(storedConfig).toEqual(installed.config);
  });

  it("stops a drifted run and snapshots the edited Project Skill only for a new run", async () => {
    const fixture = await createProject();
    const installed = await installHostManagedProject({
      fixture,
      mode: "project-skill",
      procedure: recordingProcedure,
    });
    const originalRun = await startAndCancelWebRun(fixture);
    const report = await generateReport(fixture, originalRun.runId);
    const before = await readStableRunArtifacts({
      projectRoot: fixture.projectRoot,
      runId: originalRun.runId,
      report,
    });
    const editedSkill = projectSkillSource(
      `${recordingProcedure}\nPreserve the existing heading when updating a row.`,
    );
    await writeFile(
      join(
        fixture.projectRoot,
        ".agents",
        "skills",
        "ai-qa-project",
        "SKILL.md",
      ),
      editedSkill,
    );

    for (const command of [
      ["report", "recording-status", originalRun.runId],
      ["report", "receipt", originalRun.runId, "--stdin-json"],
    ]) {
      const error = await fixture.cli.runError(
        command,
        command[1] === "receipt"
          ? projectRecordingReceipt({
              status: "recorded",
              references: ["docs/qa-results.md#run-1"],
            })
          : undefined,
      );
      expect(error.error.code).toBe("project_skill.changed");
    }
    expect(
      await readStableRunArtifacts({
        projectRoot: fixture.projectRoot,
        runId: originalRun.runId,
        report,
      }),
    ).toEqual(before);
    const reportDirectory = join(
      fixture.projectRoot,
      ".ai-qa",
      "reports",
      "runs",
      originalRun.runId,
    );
    await expect(
      access(join(reportDirectory, "recording.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(reportDirectory, "recording.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const nextRun = await startAndCancelWebRun(fixture);
    await generateReport(fixture, nextRun.runId);
    expect(originalRun.projectSkill?.contentSha256).toBe(
      contentSha256(installed.skill),
    );
    expect(nextRun.projectSkill).toEqual({
      path: ".agents/skills/ai-qa-project/SKILL.md",
      contentSha256: contentSha256(editedSkill),
    });
    expect(nextRun.projectSkill?.contentSha256).not.toBe(
      originalRun.projectSkill?.contentSha256,
    );
    expect(
      await fixture.cli.run<RecordingStatus>([
        "report",
        "recording-status",
        nextRun.runId,
      ]),
    ).toEqual({
      subject: { kind: "run", id: nextRun.runId },
      status: "pending",
      references: [],
    });
  });

  it("freezes historical recording modes across both config switch directions", async () => {
    const fixture = await createProject();
    await installHostManagedProject({ fixture, mode: "local-only" });
    const firstLocalRun = await startAndCancelWebRun(fixture);
    await generateReport(fixture, firstLocalRun.runId);

    await switchMode(fixture, "project-skill");
    const projectSkillRun = await startAndCancelWebRun(fixture);
    await generateReport(fixture, projectSkillRun.runId);
    expect(firstLocalRun.recordingPolicy).toEqual({ mode: "local-only" });
    expect(
      await fixture.cli.run<RecordingStatus>([
        "report",
        "recording-status",
        firstLocalRun.runId,
      ]),
    ).toEqual({
      subject: { kind: "run", id: firstLocalRun.runId },
      status: "not_applicable",
      references: [],
    });

    await switchMode(fixture, "local-only");
    const secondLocalRun = await startAndCancelWebRun(fixture);
    await generateReport(fixture, secondLocalRun.runId);
    expect(projectSkillRun.recordingPolicy).toEqual({ mode: "project-skill" });
    expect(projectSkillRun.projectSkill).toBeDefined();
    expect(
      await fixture.cli.run<RecordingStatus>([
        "report",
        "recording-status",
        projectSkillRun.runId,
      ]),
    ).toEqual({
      subject: { kind: "run", id: projectSkillRun.runId },
      status: "pending",
      references: [],
    });
    expect(secondLocalRun.recordingPolicy).toEqual({ mode: "local-only" });
    expect(secondLocalRun.projectSkill).toBeUndefined();
  });
});
