import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CaseRevision } from "../../src/core/cases/schema.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import type { PlatformReadiness } from "../../src/core/readiness/schema.js";
import { validateEvidenceParity } from "../../src/core/evidence/parity.js";
import {
  evidenceRecordSchema,
  type EvidenceRecord,
} from "../../src/core/evidence/schema.js";
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
import {
  activateCaseRevision,
  draftCaseFromRun,
  validateCaseRevision,
} from "../../src/services/case-promotion/draft-case.js";
import {
  exportProjectLocalRunReport,
  generateRunReport,
} from "../../src/services/report-generation/generate-run-report.js";
import { finalizeRun } from "../../src/services/run-protocol/finalize-run.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { startExploratoryRun } from "../../src/services/run-protocol/start-exploratory-run.js";
import { startRegressionRun } from "../../src/services/run-protocol/start-regression-run.js";
import { VerdictService } from "../../src/services/run-protocol/verdict-service.js";
import { syncGlobalSkill } from "../../src/services/skill-management/global-skill.js";
import { initializeTestProject } from "../helpers/project-fixture.js";

const startedAt = new Date("2026-07-13T00:00:00.000Z");
const now = () => new Date("2026-07-13T00:05:00.000Z");
const ready: PlatformReadiness & WorkOrder["readiness"] = {
  platform: "web" as const,
  status: "ready" as const,
  checks: [
    {
      code: "web.entry_url",
      status: "pass",
      message: "Configured",
      category: "environment",
    },
    {
      code: "web.entry_page",
      status: "pass",
      message: "Fixture ready",
      category: "environment",
    },
    {
      code: "web.chrome_devtools_mcp",
      status: "pass",
      message: "Chrome DevTools MCP ready",
      category: "tool",
    },
    {
      code: "agent.global_skill",
      status: "pass",
      message: "Global skill compatible",
      category: "installation",
    },
  ],
};
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
    schemaVersion: 3,
    recordingPolicy: { mode: "local-only" },
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
    secretReferences: {
      loginPassword: "AI_QA_FIXTURE_PASSWORD",
      fixtureProjectSkill: "QA_TEST_PASSWORD",
    },
  };
}

interface RunProof {
  assertionIds: string[];
  assertionKinds: string[][];
  evidenceId: string;
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
  expectMarkdownReportCoherence(markdown, json, events, evidenceRecords);
}

function expectMarkdownReportCoherence(
  markdown: string,
  json: ReturnType<typeof runReportSchema.parse>,
  events: readonly RunEvent[],
  evidenceRecords: readonly EvidenceRecord[],
): void {
  requireMarkdownFragment(
    markdown,
    `# AI QA Run ${json.run.id}`,
    "run identity",
  );
  requireMarkdownFragment(
    markdown,
    `- Status: \`${json.run.status}\``,
    "terminal status",
  );
  requireMarkdownFragment(
    markdown,
    `- Verdict: \`${json.verdict.classification}\``,
    "terminal verdict",
  );
  for (const record of evidenceRecords) {
    requireMarkdownFragment(
      markdown,
      `- \`${record.id}\` —`,
      `evidence ${record.id}`,
    );
    requireMarkdownFragment(
      markdown,
      `\`${record.contentHash}\``,
      `evidence hash ${record.id}`,
    );
    requireMarkdownFragment(
      markdown,
      `\`${record.projectRelativePath}\``,
      `evidence path ${record.id}`,
    );
  }
  for (const event of events) {
    requireMarkdownFragment(
      markdown,
      `${event.sequence}. \`${event.type}\` \`${event.id}\` —`,
      `timeline event ${event.id}`,
    );
  }
  requireMarkdownFragment(
    markdown,
    `Verified at ${json.integrity.verifiedAt}.`,
    "integrity verification time",
  );
}

function requireMarkdownFragment(
  markdown: string,
  fragment: string,
  label: string,
): void {
  if (!markdown.includes(fragment)) {
    throw new Error(`Markdown report is missing its ${label}`);
  }
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
  const captureTerminals = events.filter((event) => {
    if (event.type !== "action") return false;
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase !== "planned" && payload.actionId === capture.id;
  });
  if (
    captureTerminals.length !== 1 ||
    actionPayloadSchema.parse(captureTerminals[0]!.payload).phase !==
      "completed"
  ) {
    throw new Error("Missing completed evidence-capture terminal");
  }
  const captureTerminal = captureTerminals[0]!;
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
  const interactionTerminals = events.filter((event) => {
    if (event.type !== "action") return false;
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase !== "planned" && payload.actionId === interaction.id;
  });
  if (
    interactionTerminals.length !== 1 ||
    actionPayloadSchema.parse(interactionTerminals[0]!.payload).phase !==
      "completed"
  ) {
    throw new Error("Missing interaction terminal");
  }
  const interactionTerminal = interactionTerminals[0]!;
  expect(evidence.observationIds.length).toBeGreaterThan(0);
  for (const observationId of evidence.observationIds) {
    const observations = events.filter(
      (event) => event.type === "observation" && event.id === observationId,
    );
    if (observations.length !== 1) throw new Error("Missing observation");
    const observation = observations[0]!;
    const observationPayload = observationPayloadSchema.parse(
      observation.payload,
    );
    const observationAction = events.find(
      (event) =>
        event.type === "action" && event.id === observationPayload.actionId,
    );
    const observationActionPayload =
      observationAction === undefined
        ? undefined
        : actionPayloadSchema.parse(observationAction.payload);
    const observationTerminals =
      observationAction === undefined
        ? []
        : events.filter((event) => {
            if (event.type !== "action") return false;
            const payload = actionPayloadSchema.parse(event.payload);
            return (
              payload.phase !== "planned" &&
              payload.actionId === observationAction.id
            );
          });
    if (
      observationAction === undefined ||
      observationActionPayload?.phase !== "planned" ||
      observationActionPayload.kind !== "observation" ||
      observationActionPayload.stepId !== capturePayload.stepId ||
      observationPayload.stepId !== capturePayload.stepId ||
      observationTerminals.length !== 1 ||
      actionPayloadSchema.parse(observationTerminals[0]!.payload).phase !==
        "completed"
    ) {
      throw new Error(
        "Evidence observation must cite a completed observation action",
      );
    }
    const observationTerminal = observationTerminals[0]!;
    expect(interactionTerminal.sequence).toBeLessThan(
      observationAction.sequence,
    );
    expect(observationAction.sequence).toBeLessThan(
      observationTerminal.sequence,
    );
    expect(observationTerminal.sequence).toBeLessThan(observation.sequence);
    expect(observation.sequence).toBeLessThan(capture.sequence);
  }
  expect(capture.sequence).toBeLessThan(captureTerminal.sequence);
  expect(captureTerminal.sequence).toBeLessThan(evidenceEvent.sequence);
  const assertions = events.filter((event) => {
    if (event.type !== "assertion") return false;
    const payload = assertionPayloadSchema.parse(event.payload);
    return (
      payload.status === "satisfied" && payload.evidenceIds.includes(evidenceId)
    );
  });
  if (assertions.length === 0) throw new Error("Missing step assertion");
  for (const assertion of assertions) {
    const payload = assertionPayloadSchema.parse(assertion.payload);
    if (
      payload.stepId !== capturePayload.stepId ||
      !evidence.observationIds.every((id) =>
        payload.observationIds.includes(id),
      ) ||
      !evidence.criterionIds.includes(payload.criterionId)
    ) {
      throw new Error(
        "Every evidence assertion must cite its fresh observations",
      );
    }
    expect(evidenceEvent.sequence).toBeLessThan(assertion.sequence);
  }
  expect(
    [
      ...new Set(
        assertions.map(
          (assertion) =>
            assertionPayloadSchema.parse(assertion.payload).criterionId,
        ),
      ),
    ].sort(),
  ).toEqual([...new Set(evidence.criterionIds)].sort());
}

async function expectIntegrityMutationsRejected(input: {
  projectRoot: string;
  workOrder: WorkOrder;
  report: ReportPaths;
  exported: ReportPaths;
}): Promise<void> {
  if (input.report.markdownPath === undefined) {
    throw new Error("Web E2E requires a Markdown report mutation target");
  }
  const eventsPath = join(
    input.projectRoot,
    ".ai-qa",
    "runs",
    input.workOrder.runId,
    "events.jsonl",
  );
  const originalEvents = await readFile(eventsPath, "utf8");
  const events = originalEvents
    .trimEnd()
    .split("\n")
    .map((line) => runEventSchema.parse(JSON.parse(line)));
  const evidenceEvent = events.find((event) => event.type === "evidence");
  if (evidenceEvent === undefined) throw new Error("Missing evidence fixture");
  const evidence = evidenceEventPayloadSchema.parse(evidenceEvent.payload);
  const observation = events.find(
    (event) =>
      event.type === "observation" && event.id === evidence.observationIds[0],
  );
  if (observation === undefined)
    throw new Error("Missing observation mutation fixture");
  const observationPayload = observationPayloadSchema.parse(
    observation.payload,
  );
  const interaction = events.find((event) => {
    if (event.type !== "action") return false;
    const payload = actionPayloadSchema.parse(event.payload);
    return (
      payload.phase === "planned" &&
      payload.kind === "interaction" &&
      payload.stepId === observationPayload.stepId
    );
  });
  if (interaction === undefined)
    throw new Error("Missing interaction mutation fixture");
  const assertion = events.find((event) => {
    if (event.type !== "assertion") return false;
    const payload = assertionPayloadSchema.parse(event.payload);
    return payload.evidenceIds.includes(evidence.id);
  });
  if (assertion === undefined) throw new Error("Missing assertion fixture");
  const assertionPayload = assertionPayloadSchema.parse(assertion.payload);
  const markdownPath = join(input.projectRoot, input.report.markdownPath);
  const originalMarkdown = await readFile(markdownPath, "utf8");
  const jsonPath = input.report.jsonPath;
  if (jsonPath === undefined) throw new Error("Missing JSON report fixture");
  const report = runReportSchema.parse(
    JSON.parse(await readFile(join(input.projectRoot, jsonPath), "utf8")),
  );
  const outcomes: Record<string, string> = {};
  const probe = async (
    label: string,
    path: string,
    original: string,
    mutated: string,
  ): Promise<void> => {
    await writeFile(path, mutated);
    try {
      await expectCoherentWebArtifacts(input);
      outcomes[label] = "accepted";
    } catch (error: unknown) {
      outcomes[label] = error instanceof Error ? error.message : String(error);
    } finally {
      await writeFile(path, original);
    }
  };

  const wrongObservationAction = events.map((event) =>
    event.id === observation.id
      ? runEventSchema.parse({
          ...event,
          payload: { ...observationPayload, actionId: interaction.id },
        })
      : event,
  );
  await probe(
    "observation-action-chain",
    eventsPath,
    originalEvents,
    serializeRunEvents(wrongObservationAction),
  );

  const missingAssertionObservation = events.map((event) =>
    event.id === assertion.id
      ? runEventSchema.parse({
          ...event,
          payload: { ...assertionPayload, observationIds: [] },
        })
      : event,
  );
  await probe(
    "assertion-observation-citation",
    eventsPath,
    originalEvents,
    serializeRunEvents(missingAssertionObservation),
  );

  await probe(
    "markdown-content",
    markdownPath,
    originalMarkdown,
    `# Truncated report\n\n## Integrity\n\nVerified at ${report.integrity.verifiedAt}.\n`,
  );

  expect(outcomes).toEqual({
    "observation-action-chain":
      "Evidence observation must cite a completed observation action",
    "assertion-observation-citation":
      "Every evidence assertion must cite its fresh observations",
    "markdown-content": "Markdown report is missing its run identity",
  });
}

function serializeRunEvents(events: readonly RunEvent[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

async function recordSuccessfulLogin(input: {
  projectRoot: string;
  workOrder: WorkOrder;
  prefix: string;
  requiredStep?: WorkOrder["requiredSteps"][number];
}): Promise<{ interactionId: string; proof: RunProof }> {
  const protocol = new RunProtocolService(
    input.projectRoot,
    input.workOrder.runId,
    now,
  );
  if (input.requiredStep === undefined) {
    const initialAction = await protocol.planAction({
      idempotencyKey: `${input.prefix}-initial-observation`,
      kind: "observation",
      intent: "Observe the initial login page",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    await protocol.completeAction({
      actionId: initialAction.id,
      phase: "completed",
      toolResult: { summary: "Login page observed" },
    });
    await protocol.addObservation({
      actionId: initialAction.id,
      summary: "Login form is visible",
      state: { url: "http://127.0.0.1:4173/login" },
    });
  }

  const required = input.requiredStep;
  const interaction = await protocol.planAction({
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
    ...(required === undefined ? {} : { stepId: required.id }),
  });
  await protocol.completeAction({
    actionId: interaction.id,
    phase: "completed",
    toolResult: {
      summary: "Credentials submitted through Chrome DevTools MCP",
    },
  });
  const stepId = (interaction.payload as { stepId: string }).stepId;
  const observationAction = await protocol.planAction({
    idempotencyKey: `${input.prefix}-authenticated-observation`,
    kind: "observation",
    intent: "Observe the authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Current page" },
    stepId,
  });
  await protocol.completeAction({
    actionId: observationAction.id,
    phase: "completed",
    toolResult: { summary: "Authenticated page observed" },
  });
  const observation = await protocol.addObservation({
    actionId: observationAction.id,
    summary: "Authenticated home and current account are visible",
    state: {
      url: "http://127.0.0.1:4173/home",
      account: "qa@example.test",
    },
  });
  const capture = await protocol.planAction({
    idempotencyKey: `${input.prefix}-screenshot-action`,
    kind: "evidence-capture",
    intent: "Capture the authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Authenticated home" },
    stepId,
  });
  await protocol.completeAction({
    actionId: capture.id,
    phase: "completed",
    toolResult: { summary: "Screenshot captured" },
  });
  const sourcePath = join(
    input.projectRoot,
    `${input.workOrder.runId}-authenticated-home.png`,
  );
  await writeFile(sourcePath, Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]));
  const evidence = await registerEvidence({
    projectRoot: input.projectRoot,
    runId: input.workOrder.runId,
    payload: {
      sourcePath,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: capture.id,
      idempotencyKey: `${input.prefix}-screenshot`,
    },
    criterionIds: criteria.map((criterion) => criterion.id),
    observationIds: [observation.id],
    now,
  });
  const assertions = await Promise.all(
    criteria.map((criterion) =>
      protocol.recordAssertion({
        criterionId: criterion.id,
        status: "satisfied",
        assertionKinds: [
          criterion.id === "current-account-visible"
            ? "structured-text-assertion"
            : "semantic-ui",
        ],
        actual: criterion.description,
        expected: criterion.description,
        observationIds: [observation.id],
        evidenceIds: [evidence.id],
        stepId,
      }),
    ),
  );
  return {
    interactionId: interaction.id,
    proof: {
      assertionIds: assertions.map((assertion) => assertion.id),
      assertionKinds: assertions.map(
        (assertion) =>
          (assertion.payload as { assertionKinds: string[] }).assertionKinds,
      ),
      evidenceId: evidence.id,
    },
  };
}

async function completePass(input: {
  projectRoot: string;
  workOrder: WorkOrder;
  prefix: string;
  requiredStep?: WorkOrder["requiredSteps"][number];
}) {
  const recorded = await recordSuccessfulLogin(input);
  await new VerdictService(input.projectRoot, input.workOrder.runId, now).set({
    classification: "pass",
    summary: "Successful login is supported by UI observation and screenshot",
    criterionResults: criteria.map((criterion, index) => ({
      criterionId: criterion.id,
      status: "satisfied",
      assertionIds: [recorded.proof.assertionIds[index]!],
      evidenceIds: [recorded.proof.evidenceId],
    })),
  });
  const completed = await finalizeRun({
    projectRoot: input.projectRoot,
    runId: input.workOrder.runId,
    now,
  });
  return { ...recorded, completed };
}

async function replayActiveCase(input: {
  projectRoot: string;
  revision: CaseRevision;
  ordinal: number;
}) {
  const workOrder = await startRegressionRun({
    projectRoot: input.projectRoot,
    caseId: input.revision.caseId,
    platform: "web",
    execution: "local",
    readiness: ready,
    now: () => startedAt,
  });
  const result = await completePass({
    ...input,
    workOrder,
    prefix: `regression-${String(input.ordinal)}`,
    requiredStep: workOrder.requiredSteps[0]!,
  });
  const report = await generateRunReport({
    projectRoot: input.projectRoot,
    runId: workOrder.runId,
    now,
  });
  const exported = await exportProjectLocalRunReport({
    projectRoot: input.projectRoot,
    runId: workOrder.runId,
    now,
  });
  return { workOrder, result, report, exported };
}

describe("Web vertical slice services", () => {
  it("packages the 2.0 three-platform global skill", async () => {
    const skill = await readFile(
      join(process.cwd(), "src", "skills", "global", "SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("aiQaSkillVersion: 2.0.0");
    expect(skill).toContain("aiQaProtocolRange: ^2.0.0");
    expect(skill).toContain("aiQaRecordingReceipt: true");
  });

  it("serves a credential-safe deterministic live fixture", async () => {
    const child = spawn(
      process.execPath,
      ["fixtures/web-app/server.mjs", "--self-test"],
      {
        cwd: process.cwd(),
        env: { ...process.env, AI_QA_FIXTURE_PASSWORD: "correct-horse" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    const output = Buffer.concat(stdout).toString("utf8");
    const errors = Buffer.concat(stderr).toString("utf8");

    expect(exitCode, errors).toBe(0);
    expect(output).toBe("fixture self-test ok\n");
    expect(`${output}${errors}`).not.toContain("correct-horse");
    expect(`${output}${errors}`).not.toContain("qa@example.test");
  }, 10_000);

  it("promotes an evidence-backed exploration and passes the pinned replay twice", async () => {
    const machineHome = await mkdtemp(join(tmpdir(), "ai-qa-e2e-machine-"));
    const agentsHome = join(machineHome, "agents-home");
    const projectRoot = join(machineHome, "target-project");
    await mkdir(projectRoot, { recursive: true });
    await syncGlobalSkill({
      agentsHome,
      sourcePath: join(process.cwd(), "src", "skills", "global", "SKILL.md"),
      confirmManagedReplacement: false,
    });
    await initializeTestProject({ projectRoot, config: config() });

    const exploratory = await startExploratoryRun({
      projectRoot,
      platform: "web",
      payload: {
        goal: "Verify successful login",
        acceptanceCriteria: criteria,
        readiness: ready,
      },
      now: () => startedAt,
    });
    const exploratoryResult = await completePass({
      projectRoot,
      workOrder: exploratory,
      prefix: "exploratory",
    });
    const exploratoryReport = await generateRunReport({
      projectRoot,
      runId: exploratory.runId,
      now,
    });
    const exploratoryExport = await exportProjectLocalRunReport({
      projectRoot,
      runId: exploratory.runId,
      now,
    });
    await expectCoherentWebArtifacts({
      projectRoot,
      workOrder: exploratory,
      report: exploratoryReport,
      exported: exploratoryExport,
    });
    await expectIntegrityMutationsRejected({
      projectRoot,
      workOrder: exploratory,
      report: exploratoryReport,
      exported: exploratoryExport,
    });
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: exploratory.runId,
      input: {
        caseId: "login-success",
        title: "Successful login",
        steps: [
          {
            sourceActionId: exploratoryResult.interactionId,
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
      },
    });
    await expect(
      validateCaseRevision({
        projectRoot,
        caseId: draft.caseId,
        revision: draft.revision,
      }),
    ).resolves.toMatchObject({ valid: true, issues: [] });
    const active = await activateCaseRevision({
      projectRoot,
      caseId: draft.caseId,
      revision: draft.revision,
      reviewConfirmed: true,
      now,
    });
    const replays = [];
    for (const ordinal of [1, 2]) {
      replays.push(
        await replayActiveCase({
          projectRoot,
          revision: active,
          ordinal,
        }),
      );
    }

    expect(replays.map(({ workOrder }) => workOrder.pinnedCase)).toEqual([
      expect.objectContaining({
        caseId: active.caseId,
        revision: active.revision,
        caseContentHash: active.contentHash,
      }),
      expect.objectContaining({
        caseId: active.caseId,
        revision: active.revision,
        caseContentHash: active.contentHash,
      }),
    ]);
    expect(replays[0]!.workOrder.pinnedCase!.platformVariantHash).toBe(
      replays[1]!.workOrder.pinnedCase!.platformVariantHash,
    );
    for (const replay of replays) {
      await expectCoherentWebArtifacts({
        projectRoot,
        workOrder: replay.workOrder,
        report: replay.report,
        exported: replay.exported,
      });
    }
    expect({
      exploratoryVerdict: exploratoryResult.completed.verdict,
      activeRevision: active.revision,
      regressionVerdicts: replays.map(({ result }) => result.completed.verdict),
      uniqueRegressionRunIds: new Set(
        replays.map(({ workOrder }) => workOrder.runId),
      ).size,
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
    for (const replay of replays) {
      expect(replay.report.jsonPath).toContain(replay.workOrder.runId);
      expect(replay.report.markdownPath).toContain(replay.workOrder.runId);
      expect(replay.exported).toEqual({
        jsonPath: replay.report.jsonPath,
        markdownPath: replay.report.markdownPath,
      });
    }
  });
});
