import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/program.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { validateEvidenceParity } from "../../src/core/evidence/parity.js";
import { evidenceRecordSchema } from "../../src/core/evidence/schema.js";
import { readJsonLines } from "../../src/core/fs/json-lines.js";
import { runReportSchema } from "../../src/core/reports/schema.js";
import {
  actionPayloadSchema,
  assertionPayloadSchema,
  evidenceEventPayloadSchema,
  observationPayloadSchema,
} from "../../src/core/runs/event-payloads.js";
import {
  runEventSchema,
  type RunEvent,
  type WorkOrder,
} from "../../src/core/runs/schema.js";
import { createCapturedCli } from "../helpers/cli-context.js";

const fixedNow = () => new Date("2026-07-13T00:10:00.000Z");
const criteria = [
  {
    id: "authenticated-home-visible",
    description: "Authenticated home is visible",
    requiredEvidence: ["post-action-screenshot"],
  },
  {
    id: "current-account-visible",
    description: "The current account is visible",
    requiredEvidence: ["structured-text-assertion", "post-action-screenshot"],
  },
];

function config(): ProjectConfig {
  return {
    schemaVersion: 1,
    project: { id: "fixture-web", name: "Web QA fixture" },
    targets: { web: { entryUrl: "http://127.0.0.1:4173/login" } },
    environments: {},
    tools: { web: { controller: "chrome-devtools-mcp" } },
    evidencePolicy: {
      screenshots: "required",
      defaultSensitivity: "internal",
      retentionDays: 30,
    },
    reportPolicy: {
      formats: ["json", "markdown"],
      audience: "engineering",
      detail: "full",
    },
    storagePolicy: { adapter: "project-local" },
    gitPolicy: { config: "track", artifacts: "ignore" },
    ciPolicy: { nonPassExit: "failure" },
    secretReferences: { loginPassword: "AI_QA_FIXTURE_PASSWORD" },
  };
}

interface CliHarness {
  calls: string[][];
  run<T>(args: string[], stdin?: unknown): Promise<T>;
}

function createHarness(input: {
  projectRoot: string;
  machineHome: string;
  aiQaHome: string;
  agentsHome: string;
}): CliHarness {
  const calls: string[][] = [];
  return {
    calls,
    async run<T>(args: string[], stdin?: unknown): Promise<T> {
      calls.push(args);
      const captured = createCapturedCli({
        cwd: input.projectRoot,
        homeDir: input.machineHome,
        env: {
          AI_QA_HOME: input.aiQaHome,
          AI_QA_AGENTS_HOME: input.agentsHome,
        },
        now: fixedNow,
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

interface ProtocolEventOutput {
  eventId: string;
  payload: Record<string, unknown>;
}

interface ReportPaths {
  jsonPath?: string;
  markdownPath?: string;
}

async function expectCoherentWebArtifacts(input: {
  projectRoot: string;
  workOrder: WorkOrder;
  report: ReportPaths;
  exported: ReportPaths;
}): Promise<void> {
  expect(input.workOrder.platform).toBe("web");
  const events = await readJsonLines(
    join(
      input.projectRoot,
      ".ai-qa",
      "runs",
      input.workOrder.runId,
      "events.jsonl",
    ),
    runEventSchema,
  );
  const actionEvents = events.filter((event) => event.type === "action");
  const evidenceRecords = await readJsonLines(
    join(
      input.projectRoot,
      ".ai-qa",
      "evidence",
      input.workOrder.runId,
      "index.jsonl",
    ),
    evidenceRecordSchema,
  );
  expect(actionEvents.length).toBeGreaterThan(0);
  expect(
    actionEvents.every((event) => event.tool === "chrome-devtools-mcp"),
  ).toBe(true);
  expect(evidenceRecords.length).toBeGreaterThan(0);
  expect(
    evidenceRecords.every(
      (record) => record.sourceTool === "chrome-devtools-mcp",
    ),
  ).toBe(true);
  expect(new Set(evidenceRecords.map((record) => record.id)).size).toBe(
    evidenceRecords.length,
  );
  expect(() =>
    validateEvidenceParity(events, evidenceRecords, input.workOrder.runId),
  ).not.toThrow();
  for (const record of evidenceRecords) {
    expectFreshPostActionChain(events, record.id);
  }

  if (
    input.report.jsonPath === undefined ||
    input.report.markdownPath === undefined
  ) {
    throw new Error("Web E2E requires configured JSON and Markdown reports");
  }
  expect(input.exported).toEqual({
    jsonPath: input.report.jsonPath,
    markdownPath: input.report.markdownPath,
  });
  const json = runReportSchema.parse(
    JSON.parse(
      await readFile(join(input.projectRoot, input.report.jsonPath), "utf8"),
    ),
  );
  const markdown = await readFile(
    join(input.projectRoot, input.report.markdownPath),
    "utf8",
  );
  expect(json.run).toMatchObject({
    id: input.workOrder.runId,
    platform: "web",
    status: "completed",
  });
  expect(json.verdict.classification).toBe("pass");
  expect(json.timeline.map((entry) => entry.eventId)).toEqual(
    events.map((event) => event.id),
  );
  expect(
    [...json.evidence].sort((left, right) => left.id.localeCompare(right.id)),
  ).toEqual(
    evidenceRecords
      .map((record) => ({
        id: record.id,
        contentHash: record.contentHash,
        path: record.projectRelativePath,
        evidenceKinds: record.evidenceKinds,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  expect(markdown).toContain(`Verified at ${json.integrity.verifiedAt}.`);
}

function expectFreshPostActionChain(
  events: readonly RunEvent[],
  evidenceId: string,
): void {
  const evidenceEvent = events.find(
    (event) =>
      event.type === "evidence" &&
      evidenceEventPayloadSchema.parse(event.payload).id === evidenceId,
  );
  if (evidenceEvent === undefined) throw new Error("Missing evidence event");
  const evidence = evidenceEventPayloadSchema.parse(evidenceEvent.payload);
  const capture = events.find(
    (event) => event.type === "action" && event.id === evidence.captureActionId,
  );
  if (capture === undefined) throw new Error("Missing evidence-capture action");
  const capturePayload = actionPayloadSchema.parse(capture.payload);
  if (
    capturePayload.phase !== "planned" ||
    capturePayload.kind !== "evidence-capture"
  ) {
    throw new Error("Evidence must cite a planned evidence-capture action");
  }
  const captureTerminal = events.find((event) => {
    if (event.type !== "action") return false;
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase === "completed" && payload.actionId === capture.id;
  });
  if (captureTerminal === undefined)
    throw new Error("Missing completed evidence-capture terminal");
  const interaction = events.find((event) => {
    if (event.type !== "action") return false;
    const payload = actionPayloadSchema.parse(event.payload);
    return (
      payload.phase === "planned" &&
      payload.kind === "interaction" &&
      payload.stepId === capturePayload.stepId
    );
  });
  if (interaction === undefined) throw new Error("Missing step interaction");
  const interactionTerminal = events.find((event) => {
    if (event.type !== "action") return false;
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase === "completed" && payload.actionId === interaction.id;
  });
  if (interactionTerminal === undefined)
    throw new Error("Missing interaction terminal");
  expect(evidence.observationIds.length).toBeGreaterThan(0);
  for (const observationId of evidence.observationIds) {
    const observation = events.find(
      (event) => event.type === "observation" && event.id === observationId,
    );
    if (observation === undefined) throw new Error("Missing observation");
    expect(observationPayloadSchema.parse(observation.payload).stepId).toBe(
      capturePayload.stepId,
    );
    expect(interactionTerminal.sequence).toBeLessThan(observation.sequence);
    expect(observation.sequence).toBeLessThan(capture.sequence);
  }
  expect(capture.sequence).toBeLessThan(captureTerminal.sequence);
  expect(captureTerminal.sequence).toBeLessThan(evidenceEvent.sequence);
  const assertion = events.find((event) => {
    if (event.type !== "assertion") return false;
    const payload = assertionPayloadSchema.parse(event.payload);
    return (
      payload.status === "satisfied" &&
      payload.stepId === capturePayload.stepId &&
      payload.evidenceIds.includes(evidenceId)
    );
  });
  if (assertion === undefined) throw new Error("Missing step assertion");
  expect(evidenceEvent.sequence).toBeLessThan(assertion.sequence);
}

async function plan(
  cli: CliHarness,
  runId: string,
  input: {
    idempotencyKey: string;
    kind: "interaction" | "observation" | "evidence-capture";
    intent: string;
    tool: string;
    target: { description: string; selector?: string };
  },
  stepId?: string,
): Promise<ProtocolEventOutput> {
  return cli.run<ProtocolEventOutput>(
    [
      "action",
      "plan",
      "--run",
      runId,
      ...(stepId === undefined ? [] : ["--step", stepId]),
      "--stdin-json",
    ],
    input,
  );
}

async function complete(
  cli: CliHarness,
  runId: string,
  actionId: string,
  summary: string,
): Promise<void> {
  await cli.run(
    ["action", "complete", actionId, "--run", runId, "--stdin-json"],
    { phase: "completed", toolResult: { summary } },
  );
}

async function recordSuccessfulLogin(input: {
  cli: CliHarness;
  projectRoot: string;
  run: WorkOrder;
  prefix: string;
  requiredStep?: WorkOrder["requiredSteps"][number];
}) {
  if (input.requiredStep === undefined) {
    const initial = await plan(input.cli, input.run.runId, {
      idempotencyKey: `${input.prefix}-initial-observation`,
      kind: "observation",
      intent: "Observe the initial login page",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    await complete(
      input.cli,
      input.run.runId,
      initial.eventId,
      "Login page observed",
    );
    await input.cli.run(
      ["observation", "add", "--run", input.run.runId, "--stdin-json"],
      {
        actionId: initial.eventId,
        summary: "Login form is visible",
        state: { url: "http://127.0.0.1:4173/login" },
      },
    );
  }

  const required = input.requiredStep;
  const interaction = await plan(
    input.cli,
    input.run.runId,
    {
      idempotencyKey: `${input.prefix}-login`,
      kind: "interaction",
      intent: required?.intent ?? "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target:
        required === undefined
          ? {
              description: "Login submit button",
              selector: '[data-testid="login-submit"]',
            }
          : {
              description: required.target.description,
              ...(required.target.selector === undefined
                ? {}
                : { selector: required.target.selector }),
            },
    },
    required?.id,
  );
  await complete(
    input.cli,
    input.run.runId,
    interaction.eventId,
    "Credentials submitted through Chrome DevTools MCP",
  );
  const stepId = String(interaction.payload.stepId);
  const observationAction = await plan(
    input.cli,
    input.run.runId,
    {
      idempotencyKey: `${input.prefix}-authenticated-observation`,
      kind: "observation",
      intent: "Observe the authenticated home",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    },
    stepId,
  );
  await complete(
    input.cli,
    input.run.runId,
    observationAction.eventId,
    "Authenticated page observed",
  );
  const observation = await input.cli.run<ProtocolEventOutput>(
    ["observation", "add", "--run", input.run.runId, "--stdin-json"],
    {
      actionId: observationAction.eventId,
      summary: "Authenticated home and current account are visible",
      state: {
        url: "http://127.0.0.1:4173/home",
        account: "qa@example.test",
      },
    },
  );
  const capture = await plan(
    input.cli,
    input.run.runId,
    {
      idempotencyKey: `${input.prefix}-screenshot-action`,
      kind: "evidence-capture",
      intent: "Capture the authenticated home",
      tool: "chrome-devtools-mcp",
      target: { description: "Authenticated home" },
    },
    stepId,
  );
  await complete(
    input.cli,
    input.run.runId,
    capture.eventId,
    "Screenshot captured",
  );
  const screenshotName = `${input.run.runId}-authenticated-home.png`;
  await writeFile(
    join(input.projectRoot, screenshotName),
    Buffer.from([137, 80, 78, 71, 4, 3, 2, 1]),
  );
  const evidence = await input.cli.run<{ id: string }>(
    [
      "evidence",
      "add",
      "--run",
      input.run.runId,
      "--file",
      screenshotName,
      "--stdin-json",
    ],
    {
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: capture.eventId,
      idempotencyKey: `${input.prefix}-screenshot`,
      criterionIds: criteria.map((criterion) => criterion.id),
      observationIds: [observation.eventId],
    },
  );
  const assertions: string[] = [];
  const assertionKinds: string[][] = [];
  for (const criterion of criteria) {
    const assertion = await input.cli.run<ProtocolEventOutput>(
      [
        "assertion",
        "record",
        "--run",
        input.run.runId,
        "--step",
        stepId,
        "--stdin-json",
      ],
      {
        criterionId: criterion.id,
        status: "satisfied",
        assertionKinds: [
          criterion.id === "current-account-visible"
            ? "structured-text-assertion"
            : "semantic-ui",
        ],
        actual: criterion.description,
        expected: criterion.description,
        observationIds: [observation.eventId],
        evidenceIds: [evidence.id],
      },
    );
    assertions.push(assertion.eventId);
    assertionKinds.push(assertion.payload.assertionKinds as string[]);
  }
  return {
    interactionId: interaction.eventId,
    assertionIds: assertions,
    assertionKinds,
    evidenceId: evidence.id,
  };
}

async function passAndFinish(input: {
  cli: CliHarness;
  projectRoot: string;
  run: WorkOrder;
  prefix: string;
  requiredStep?: WorkOrder["requiredSteps"][number];
}) {
  const proof = await recordSuccessfulLogin(input);
  await input.cli.run(
    ["verdict", "set", "--run", input.run.runId, "--stdin-json"],
    {
      classification: "pass",
      summary: "Successful login is supported by UI observation and screenshot",
      criterionResults: criteria.map((criterion, index) => ({
        criterionId: criterion.id,
        status: "satisfied",
        assertionIds: [proof.assertionIds[index]!],
        evidenceIds: [proof.evidenceId],
      })),
    },
  );
  const completed = await input.cli.run<{ verdict: string }>([
    "run",
    "finish",
    input.run.runId,
  ]);
  return { proof, completed };
}

describe("Increment 1 Web vertical slice CLI", () => {
  it("drives every public command through exploration and two pinned passes", async () => {
    const machineHome = await mkdtemp(join(tmpdir(), "ai-qa-cli-e2e-"));
    const projectRoot = join(machineHome, "target-project");
    const aiQaHome = join(machineHome, "ai-qa-home");
    const agentsHome = join(machineHome, "agents-home");
    await mkdir(projectRoot, { recursive: true });
    const cli = createHarness({
      projectRoot,
      machineHome,
      aiQaHome,
      agentsHome,
    });

    await cli.run(["skill", "install", "--global"]);
    await cli.run(
      ["trust", "confirm", "--project", projectRoot, "--stdin-json"],
      { confirmed: true },
    );
    await cli.run(["init", "--project", projectRoot, "--stdin-json"], {
      config: config(),
    });
    const doctor = await cli.run<WorkOrder["readiness"]>(
      ["doctor", "--platform", "web", "--json", "--stdin-json"],
      {
        entryPage: {
          status: "ready",
          observedAt: fixedNow().toISOString(),
          evidence: "Login fixture rendered through Chrome DevTools MCP",
        },
        chromeDevtoolsMcp: {
          status: "ready",
          observedAt: fixedNow().toISOString(),
          evidence: "Chrome DevTools MCP capability confirmed",
        },
      },
    );
    expect(doctor.status).toBe("ready");
    const exploratory = await cli.run<WorkOrder>(
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
        goal: "Verify successful login",
        acceptanceCriteria: criteria,
        readiness: doctor,
      },
    );
    const exploratoryResult = await passAndFinish({
      cli,
      projectRoot,
      run: exploratory,
      prefix: "exploratory",
    });
    const exploratoryReport = await cli.run<ReportPaths>([
      "report",
      "generate",
      exploratory.runId,
    ]);
    const exploratoryExport = await cli.run<ReportPaths>([
      "report",
      "export",
      exploratory.runId,
      "--adapter",
      "project-local",
    ]);
    await expectCoherentWebArtifacts({
      projectRoot,
      workOrder: exploratory,
      report: exploratoryReport,
      exported: exploratoryExport,
    });

    const draft = await cli.run<{
      caseId: string;
      revision: number;
      contentHash: string;
    }>(["case", "draft", "--from-run", exploratory.runId, "--stdin-json"], {
      caseId: "login-success",
      title: "Successful login",
      webSteps: [
        {
          sourceActionId: exploratoryResult.proof.interactionId,
          intent: "Submit valid credentials",
          target: {
            description: "Login submit button",
            selector: '[data-testid="login-submit"]',
            stability: "stable",
            stabilityRationale: "Fixture-owned unique data-testid",
          },
          expectedState: "Authenticated home and account are visible",
          assertionStrategy: "Observe the authenticated home and account",
          evidenceCheckpoints: [
            "structured-text-assertion",
            "post-action-screenshot",
          ],
        },
      ],
      excludedActions: [],
    });
    await expect(
      cli.run([
        "case",
        "validate",
        draft.caseId,
        "--revision",
        String(draft.revision),
      ]),
    ).resolves.toMatchObject({ valid: true, issues: [] });
    const active = await cli.run<{
      activeRevision: number;
      contentHash: string;
    }>(
      [
        "case",
        "activate",
        draft.caseId,
        "--revision",
        String(draft.revision),
        "--stdin-json",
      ],
      { reviewConfirmed: true },
    );

    const regressionRuns: WorkOrder[] = [];
    const regressionVerdicts: string[] = [];
    const regressionReports: ReportPaths[] = [];
    const regressionExports: ReportPaths[] = [];
    for (const ordinal of [1, 2]) {
      const regression = await cli.run<WorkOrder>(
        [
          "run",
          "start",
          "--kind",
          "regression",
          "--case",
          draft.caseId,
          "--platform",
          "web",
          "--execution",
          "local",
          "--stdin-json",
        ],
        doctor,
      );
      regressionRuns.push(regression);
      const result = await passAndFinish({
        cli,
        projectRoot,
        run: regression,
        prefix: `regression-${String(ordinal)}`,
        requiredStep: regression.requiredSteps[0]!,
      });
      regressionVerdicts.push(result.completed.verdict);
      const report = await cli.run<ReportPaths>([
        "report",
        "generate",
        regression.runId,
      ]);
      const exported = await cli.run<ReportPaths>([
        "report",
        "export",
        regression.runId,
        "--adapter",
        "project-local",
      ]);
      regressionReports.push(report);
      regressionExports.push(exported);
      await expectCoherentWebArtifacts({
        projectRoot,
        workOrder: regression,
        report,
        exported,
      });
    }

    expect(regressionRuns.map((run) => run.pinnedCase)).toEqual([
      expect.objectContaining({
        caseId: draft.caseId,
        revision: active.activeRevision,
        caseContentHash: active.contentHash,
      }),
      expect.objectContaining({
        caseId: draft.caseId,
        revision: active.activeRevision,
        caseContentHash: active.contentHash,
      }),
    ]);
    expect(regressionRuns[0]!.pinnedCase!.platformVariantHash).toBe(
      regressionRuns[1]!.pinnedCase!.platformVariantHash,
    );
    expect({
      exploratoryVerdict: exploratoryResult.completed.verdict,
      activeRevision: active.activeRevision,
      regressionVerdicts,
      uniqueRegressionRunIds: new Set(regressionRuns.map((run) => run.runId))
        .size,
      accountRequiredEvidence: criteria[1]!.requiredEvidence,
      accountAssertionKinds: exploratoryResult.proof.assertionKinds[1],
      reportFormats: [
        exploratoryReport.jsonPath === undefined ? undefined : "json",
        exploratoryReport.markdownPath === undefined ? undefined : "markdown",
      ],
    }).toMatchObject({
      exploratoryVerdict: "pass",
      activeRevision: 1,
      regressionVerdicts: ["pass", "pass"],
      uniqueRegressionRunIds: 2,
      accountRequiredEvidence: [
        "structured-text-assertion",
        "post-action-screenshot",
      ],
      accountAssertionKinds: ["structured-text-assertion"],
      reportFormats: ["json", "markdown"],
    });
    expect(regressionReports).toHaveLength(2);
    expect(regressionExports).toEqual(regressionReports);
    expect(
      regressionReports.every(
        (report) =>
          report.jsonPath?.endsWith("report.json") === true &&
          report.markdownPath?.endsWith("report.md") === true,
      ),
    ).toBe(true);
    expect(
      cli.calls.filter((args) => args[0] === "report" && args[1] === "export"),
    ).toHaveLength(3);
  }, 20_000);
});
