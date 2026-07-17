import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { sha256Canonical } from "../../src/core/canonical-json.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";
import { finalizeRun } from "../../src/services/run-protocol/finalize-run.js";
import { createPreflightResultRun } from "../../src/services/run-protocol/create-preflight-result-run.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { readRunState } from "../../src/services/run-protocol/read-run-state.js";
import {
  cancelRun,
  resumeRun,
} from "../../src/services/run-protocol/run-lifecycle.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { VerdictService } from "../../src/services/run-protocol/verdict-service.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import { initializeTestProject } from "../helpers/project-fixture.js";

const now = () => new Date("2026-07-13T00:10:00.000Z");
const startedAt = new Date("2026-07-13T00:00:00.000Z");

const config: ProjectConfig = {
  schemaVersion: 3,
  recordingPolicy: { mode: "local-only" },
  project: { id: "sample-web", name: "Sample Web" },
  targets: { web: { entryUrl: "https://example.com" } },
  environments: {},
  tools: { web: { controller: "chrome-devtools-mcp" } },
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
  storagePolicy: { adapter: "project-local" },
  gitPolicy: { config: "track", artifacts: "ignore" },
  ciPolicy: { nonPassExit: "failure" },
  secretReferences: { fixtureProjectSkill: "QA_TEST_PASSWORD" },
};

async function createRun(
  options: {
    screenshots?: "required" | "on-failure" | "optional";
    requiredEvidence?: string[];
  } = {},
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-finalize-project-"));
  const repository = new RunRepository(projectRoot, () => startedAt);
  await repository.create(
    createExploratoryWorkOrder({
      platform: "web",
      projectId: "sample-web",
      runId: "run-1",
      input: exploratoryRunInputSchema.parse({
        goal: "Verify successful login",
        acceptanceCriteria: [
          {
            id: "authenticated-home-visible",
            description: "Authenticated home is visible",
            requiredEvidence: options.requiredEvidence ?? [
              "post-action-screenshot",
            ],
          },
        ],
        readiness: { platform: "web", status: "ready", checks: [] },
      }),
      evidencePolicy: {
        screenshots: options.screenshots ?? "required",
        defaultSensitivity: "internal",
      },
      startedAt,
    }),
  );
  return {
    projectRoot,
    repository,
    protocol: new RunProtocolService(projectRoot, "run-1", now),
    verdicts: new VerdictService(projectRoot, "run-1", now),
  };
}

async function createPreflightProject() {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-preflight-project-"));
  await initializeTestProject({ projectRoot, config });
  return { projectRoot };
}

async function recordSupportedCriterion(
  fixture: Awaited<ReturnType<typeof createRun>>,
) {
  const observationAction = await fixture.protocol.planAction({
    idempotencyKey: "observe-home",
    kind: "observation",
    intent: "Observe authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Current page" },
  });
  await fixture.protocol.completeAction({
    actionId: observationAction.id,
    phase: "completed",
    toolResult: { summary: "Observed current page" },
  });
  const observation = await fixture.protocol.addObservation({
    actionId: observationAction.id,
    summary: "Authenticated home is visible",
    state: { url: "https://example.com/home" },
  });
  const stepId = (observationAction.payload as { stepId: string }).stepId;
  const capture = await fixture.protocol.planAction({
    idempotencyKey: "capture-home",
    kind: "evidence-capture",
    intent: "Capture authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Authenticated home" },
    stepId,
  });
  await fixture.protocol.completeAction({
    actionId: capture.id,
    phase: "completed",
    toolResult: { summary: "Screenshot captured" },
  });
  const sourcePath = join(fixture.projectRoot, "home.png");
  await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
  const evidence = await registerEvidence({
    projectRoot: fixture.projectRoot,
    runId: "run-1",
    payload: {
      sourcePath,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: capture.id,
      idempotencyKey: "home-screenshot",
    },
    criterionIds: ["authenticated-home-visible"],
    observationIds: [observation.id],
    now,
  });
  const assertion = await fixture.protocol.recordAssertion({
    criterionId: "authenticated-home-visible",
    status: "satisfied",
    assertionKinds: ["semantic-ui"],
    actual: "Authenticated home is visible",
    expected: "Authenticated home is visible",
    observationIds: [observation.id],
    evidenceIds: [evidence.id],
    stepId,
  });
  return { assertion, evidence };
}

async function recordObservationForStep(
  fixture: Awaited<ReturnType<typeof createRun>>,
  stepId: string,
  idempotencyKey: string,
) {
  const action = await fixture.protocol.planAction({
    idempotencyKey,
    kind: "observation",
    intent: "Observe authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Authenticated home" },
    stepId,
  });
  await fixture.protocol.completeAction({
    actionId: action.id,
    phase: "completed",
    toolResult: { summary: "Observed authenticated home" },
  });
  return fixture.protocol.addObservation({
    actionId: action.id,
    summary: "Authenticated home is visible",
    state: { screen: "home" },
  });
}

function recordSemanticAssertion(
  fixture: Awaited<ReturnType<typeof createRun>>,
  stepId: string,
  observationId: string,
) {
  return fixture.protocol.recordAssertion({
    criterionId: "authenticated-home-visible",
    status: "satisfied",
    assertionKinds: ["semantic-ui"],
    actual: "Authenticated home is visible",
    expected: "Authenticated home is visible",
    observationIds: [observationId],
    evidenceIds: [],
    stepId,
  });
}

function recordSemanticPass(
  fixture: Awaited<ReturnType<typeof createRun>>,
  assertionId: string,
) {
  return fixture.verdicts.set({
    classification: "pass",
    summary: "Authenticated home is supported by a semantic assertion",
    criterionResults: [
      {
        criterionId: "authenticated-home-visible",
        status: "satisfied",
        assertionIds: [assertionId],
        evidenceIds: [],
      },
    ],
  });
}

async function recordStalePass(fixture: Awaited<ReturnType<typeof createRun>>) {
  const initialObservationAction = await fixture.protocol.planAction({
    idempotencyKey: "observe-initial-login-state",
    kind: "observation",
    intent: "Observe the initial login state",
    tool: "chrome-devtools-mcp",
    target: { description: "Current page" },
  });
  await fixture.protocol.completeAction({
    actionId: initialObservationAction.id,
    phase: "completed",
    toolResult: { summary: "Initial login state observed" },
  });
  const initialObservation = await fixture.protocol.addObservation({
    actionId: initialObservationAction.id,
    summary: "The login form is visible",
    state: { url: "https://example.com/login" },
  });
  const initialStepId = (initialObservationAction.payload as { stepId: string })
    .stepId;
  const initialCapture = await fixture.protocol.planAction({
    idempotencyKey: "capture-initial-login-state",
    kind: "evidence-capture",
    intent: "Capture the initial login state",
    tool: "chrome-devtools-mcp",
    target: { description: "Login form" },
    stepId: initialStepId,
  });
  await fixture.protocol.completeAction({
    actionId: initialCapture.id,
    phase: "completed",
    toolResult: { summary: "Initial login screenshot captured" },
  });
  const sourcePath = join(fixture.projectRoot, "initial-login.png");
  await writeFile(sourcePath, Buffer.from([4, 3, 2, 1]));
  const staleEvidence = await registerEvidence({
    projectRoot: fixture.projectRoot,
    runId: "run-1",
    payload: {
      sourcePath,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: initialCapture.id,
      idempotencyKey: "initial-login-screenshot",
    },
    criterionIds: ["authenticated-home-visible"],
    observationIds: [initialObservation.id],
    now,
  });
  const submit = await fixture.protocol.planAction({
    idempotencyKey: "submit-after-initial-evidence",
    kind: "interaction",
    intent: "Submit valid credentials",
    tool: "chrome-devtools-mcp",
    target: { description: "Login button" },
  });
  await fixture.protocol.completeAction({
    actionId: submit.id,
    phase: "completed",
    toolResult: { summary: "Credentials submitted" },
  });
  const submitStepId = (submit.payload as { stepId: string }).stepId;
  const assertion = await fixture.protocol.recordAssertion({
    criterionId: "authenticated-home-visible",
    status: "satisfied",
    assertionKinds: ["semantic-ui"],
    actual: "Authenticated home is visible",
    expected: "Authenticated home is visible",
    observationIds: [initialObservation.id],
    evidenceIds: [staleEvidence.id],
    stepId: submitStepId,
  });
  return fixture.verdicts.set({
    classification: "pass",
    summary: "Old login evidence was relabeled as post-submit proof",
    criterionResults: [
      {
        criterionId: "authenticated-home-visible",
        status: "satisfied",
        assertionIds: [assertion.id],
        evidenceIds: [staleEvidence.id],
      },
    ],
  });
}

async function appendInterrupted(
  fixture: Awaited<ReturnType<typeof createRun>>,
) {
  const events = await fixture.repository.journal("run-1").readAll();
  const previous = events.filter((event) => event.type === "run").at(-1)!;
  return fixture.repository.journal("run-1").append({
    type: "run",
    actor: "ai-qa",
    platform: "web",
    tool: "ai-qa",
    idempotencyKey: `interrupt:run-1:${previous.id}`,
    payload: {
      phase: "interrupted",
      previousLifecycleEventId: previous.id,
    },
    relatedIds: [previous.id],
  });
}

async function appendDuplicateTypedEvidenceEvent(
  fixture: Awaited<ReturnType<typeof createRun>>,
): Promise<void> {
  const eventsPath = join(
    fixture.projectRoot,
    ".ai-qa",
    "runs",
    "run-1",
    "events.jsonl",
  );
  const events = (await readFile(eventsPath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const evidence = events.find((event) => event.type === "evidence");
  if (evidence === undefined) throw new Error("missing evidence event");
  events.push({
    ...evidence,
    sequence: events.length + 1,
  });
  await writeFile(
    eventsPath,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

describe("finalizeRun", () => {
  it("rejects duplicate evidence index records before finish", async () => {
    const fixture = await createRun();
    const support = await recordSupportedCriterion(fixture);
    const indexPath = join(
      fixture.projectRoot,
      ".ai-qa",
      "evidence",
      "run-1",
      "index.jsonl",
    );
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, `${index}${index}`);
    await fixture.verdicts.set({
      classification: "pass",
      summary: "Login verified",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: [support.assertion.id],
          evidenceIds: [support.evidence.id],
        },
      ],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });

  it("classifies duplicate typed evidence as an evidence integrity error", async () => {
    const fixture = await createRun();
    const support = await recordSupportedCriterion(fixture);
    await fixture.verdicts.set({
      classification: "pass",
      summary: "Login verified",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: [support.assertion.id],
          evidenceIds: [support.evidence.id],
        },
      ],
    });
    await appendDuplicateTypedEvidenceEvent(fixture);

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });

  it("verifies evidence before resolving active-run verdict cardinality", async () => {
    const fixture = await createRun();
    const support = await recordSupportedCriterion(fixture);
    await fixture.verdicts.set({
      classification: "pass",
      summary: "Initial evidence-backed pass",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: [support.assertion.id],
          evidenceIds: [support.evidence.id],
        },
      ],
    });
    const competing = {
      classification: "not_verified" as const,
      reasonCode: "incomplete_coverage" as const,
      summary: "Adversarial competing verdict",
      criterionResults: [],
    };
    await fixture.repository.journal("run-1").append({
      type: "verdict",
      actor: "agent",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: `verdict:${sha256Canonical(competing)}`,
      payload: competing,
      relatedIds: [],
    });
    await writeFile(
      join(fixture.projectRoot, support.evidence.projectRelativePath),
      Buffer.from([7, 7, 7]),
    );

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });

  it("does not let an executable run complete without any platform action", async () => {
    const fixture = await createRun();
    const [started] = await fixture.repository.journal("run-1").readAll();
    const blocker = await fixture.verdicts.recordBlocker({
      subtype: "tool",
      condition: "Web control was not attempted",
      attemptEventIds: [started!.id],
      criterionIds: [],
    });
    await fixture.verdicts.set({
      classification: "blocked",
      blockerSubtype: "tool",
      blockerIds: [blocker.id],
      summary: "No platform action was attempted",
      criterionResults: [],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "run.action_required" });
  });

  it("rejects a pass without assertion and evidence support", async () => {
    const fixture = await createRun();
    const observationAction = await fixture.protocol.planAction({
      idempotencyKey: "observe-unsupported-pass",
      kind: "observation",
      intent: "Observe the claimed successful state",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    await fixture.protocol.completeAction({
      actionId: observationAction.id,
      phase: "completed",
      toolResult: { summary: "Observed current page" },
    });
    await fixture.protocol.addObservation({
      actionId: observationAction.id,
      summary: "Authenticated home appeared visible",
      state: { url: "https://example.com/home" },
    });
    await fixture.verdicts.set({
      classification: "pass",
      summary: "Login appeared successful",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: [],
          evidenceIds: [],
        },
      ],
    });
    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "verdict.unsupported_pass" });
  });

  it("rejects pre-action evidence laundered as post-action proof", async () => {
    const fixture = await createRun();
    await recordStalePass(fixture);

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({
      code: "verdict.stale_post_action_evidence",
    });
  });

  it("rejects a stale assertion observation when screenshots are optional", async () => {
    const fixture = await createRun({
      screenshots: "optional",
      requiredEvidence: ["semantic-ui"],
    });
    const stepId = "step-login";
    const beforeAction = await fixture.protocol.planAction({
      idempotencyKey: "observe-before-login",
      kind: "observation",
      intent: "Observe the login form before submission",
      tool: "chrome-devtools-mcp",
      target: { description: "Login form" },
      stepId,
    });
    await fixture.protocol.completeAction({
      actionId: beforeAction.id,
      phase: "completed",
      toolResult: { summary: "Observed the login form" },
    });
    const staleObservation = await fixture.protocol.addObservation({
      actionId: beforeAction.id,
      summary: "The login form is visible",
      state: { screen: "login" },
    });
    const interaction = await fixture.protocol.planAction({
      idempotencyKey: "submit-login",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: { description: "Login button" },
      stepId,
    });
    await fixture.protocol.completeAction({
      actionId: interaction.id,
      phase: "completed",
      toolResult: { summary: "Credentials submitted" },
    });
    const assertion = await fixture.protocol.recordAssertion({
      criterionId: "authenticated-home-visible",
      status: "satisfied",
      assertionKinds: ["semantic-ui"],
      actual: "Authenticated home is visible",
      expected: "Authenticated home is visible",
      observationIds: [staleObservation.id],
      evidenceIds: [],
      stepId,
    });
    await fixture.verdicts.set({
      classification: "pass",
      summary: "A pre-login observation cannot support the post-login pass",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: [assertion.id],
          evidenceIds: [],
        },
      ],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({
      code: "verdict.stale_post_action_evidence",
    });
  });

  it("accepts a fresh assertion observation when screenshots are optional", async () => {
    const fixture = await createRun({
      screenshots: "optional",
      requiredEvidence: ["semantic-ui"],
    });
    const stepId = "step-login";
    const interaction = await fixture.protocol.planAction({
      idempotencyKey: "submit-before-observation",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: { description: "Login button" },
      stepId,
    });
    await fixture.protocol.completeAction({
      actionId: interaction.id,
      phase: "completed",
      toolResult: { summary: "Credentials submitted" },
    });
    const observation = await recordObservationForStep(
      fixture,
      stepId,
      "observe-after-login",
    );
    const assertion = await recordSemanticAssertion(
      fixture,
      stepId,
      observation.id,
    );
    await recordSemanticPass(fixture, assertion.id);

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).resolves.toMatchObject({ status: "completed", verdict: "pass" });
  });

  it("preserves observation-only passes without interactions", async () => {
    const fixture = await createRun({
      screenshots: "optional",
      requiredEvidence: ["semantic-ui"],
    });
    const stepId = "step-static-page";
    const observation = await recordObservationForStep(
      fixture,
      stepId,
      "observe-static-page",
    );
    const assertion = await recordSemanticAssertion(
      fixture,
      stepId,
      observation.id,
    );
    await recordSemanticPass(fixture, assertion.id);

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).resolves.toMatchObject({ status: "completed", verdict: "pass" });
  });

  it("revalidates pre-action evidence on a completed finalize retry", async () => {
    const fixture = await createRun();
    const verdict = await recordStalePass(fixture);
    await fixture.repository.journal("run-1").append({
      type: "run",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "finish:run-1",
      payload: { phase: "completed", verdictId: verdict.id },
      relatedIds: [verdict.id],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({
      code: "verdict.stale_post_action_evidence",
    });
  });

  it("preserves a valid completed finalize retry without appending events", async () => {
    const fixture = await createRun();
    const support = await recordSupportedCriterion(fixture);
    await fixture.verdicts.set({
      classification: "pass",
      summary: "Login is supported by observation and screenshot evidence",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: [support.assertion.id],
          evidenceIds: [support.evidence.id],
        },
      ],
    });
    const result = await finalizeRun({
      projectRoot: fixture.projectRoot,
      runId: "run-1",
      now,
    });
    expect(result).toMatchObject({
      runId: "run-1",
      status: "completed",
      verdict: "pass",
    });
    const beforeRetry = await fixture.repository.journal("run-1").readAll();
    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).resolves.toEqual(result);
    await expect(
      fixture.repository.journal("run-1").readAll(),
    ).resolves.toEqual(beforeRetry);
  });

  it("re-verifies evidence bytes on a completed finalize retry", async () => {
    const fixture = await createRun();
    const support = await recordSupportedCriterion(fixture);
    await fixture.verdicts.set({
      classification: "pass",
      summary: "Login is supported by observation and screenshot evidence",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: [support.assertion.id],
          evidenceIds: [support.evidence.id],
        },
      ],
    });
    await finalizeRun({
      projectRoot: fixture.projectRoot,
      runId: "run-1",
      now,
    });
    await writeFile(
      join(fixture.projectRoot, support.evidence.projectRelativePath),
      Buffer.from([9, 9, 9]),
    );

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });

  it("re-verifies exact parity on a completed finalize retry", async () => {
    const fixture = await createRun();
    const support = await recordSupportedCriterion(fixture);
    await fixture.verdicts.set({
      classification: "pass",
      summary: "Login is supported by observation and screenshot evidence",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: [support.assertion.id],
          evidenceIds: [support.evidence.id],
        },
      ],
    });
    await finalizeRun({
      projectRoot: fixture.projectRoot,
      runId: "run-1",
      now,
    });
    const indexPath = join(
      fixture.projectRoot,
      ".ai-qa",
      "evidence",
      "run-1",
      "index.jsonl",
    );
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, `${index}${index}`);

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });

  it("rejects an otherwise supported pass after the frozen deadline", async () => {
    const fixture = await createRun();
    const support = await recordSupportedCriterion(fixture);
    await fixture.verdicts.set({
      classification: "pass",
      summary: "Login is fully supported but completion is late",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: [support.assertion.id],
          evidenceIds: [support.evidence.id],
        },
      ],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now: () => new Date("2026-07-13T00:30:00.001Z"),
      }),
    ).rejects.toMatchObject({ code: "run.deadline_exceeded" });
  });

  it("rejects a not_verified reason that does not match run history", async () => {
    const fixture = await createRun();
    const observationAction = await fixture.protocol.planAction({
      idempotencyKey: "observe-before-not-verified",
      kind: "observation",
      intent: "Inspect current state before ending without coverage",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    await fixture.protocol.completeAction({
      actionId: observationAction.id,
      phase: "completed",
      toolResult: { summary: "Observed current page" },
    });
    await fixture.verdicts.set({
      classification: "not_verified",
      reasonCode: "budget_exhausted",
      summary: "The reason code must not invent budget exhaustion",
      criterionResults: [],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "verdict.unsupported_not_verified" });
  });

  it("supports not_verified when the frozen recovery budget is exhausted", async () => {
    const fixture = await createRun();
    const base = await fixture.protocol.planAction({
      idempotencyKey: "base-recovery-step",
      kind: "interaction",
      intent: "Establish the recoverable interaction step",
      tool: "chrome-devtools-mcp",
      target: { description: "Retryable button" },
    });
    await fixture.protocol.completeAction({
      actionId: base.id,
      phase: "completed",
      toolResult: { summary: "Base attempt completed" },
    });
    const stepId = (base.payload as { stepId: string }).stepId;
    for (let index = 0; index < 10; index += 1) {
      const recovery = await fixture.protocol.planAction({
        idempotencyKey: `recovery-${String(index)}`,
        kind: "interaction",
        intent: `Recovery attempt ${String(index + 1)}`,
        tool: "chrome-devtools-mcp",
        target: { description: "Retryable button" },
        recoveryForStepId: stepId,
      });
      if (index === 9) {
        await fixture.protocol.completeAction({
          actionId: recovery.id,
          phase: "completed",
          toolResult: { summary: "Final allowed recovery completed" },
        });
        continue;
      }
      await fixture.protocol.completeAction({
        actionId: recovery.id,
        phase: "unknown",
        toolResult: { summary: "Recovery result was ambiguous" },
      });
      const observationAction = await fixture.protocol.planAction({
        idempotencyKey: `observe-recovery-${String(index)}`,
        kind: "observation",
        intent: "Observe ambiguous recovery state",
        tool: "chrome-devtools-mcp",
        target: { description: "Current page" },
        stepId,
      });
      await fixture.protocol.completeAction({
        actionId: observationAction.id,
        phase: "completed",
        toolResult: { summary: "Observed recovery state" },
      });
      const observation = await fixture.protocol.addObservation({
        actionId: observationAction.id,
        summary: "Recovery was not applied",
        state: { attempt: index },
      });
      await fixture.protocol.resolveUnknownAction({
        actionId: recovery.id,
        resolution: "not_applied",
        observationId: observation.id,
        rationale: "Fresh observation shows no state change",
      });
    }
    await fixture.verdicts.set({
      classification: "not_verified",
      reasonCode: "budget_exhausted",
      summary: "No further recovery is permitted by the frozen budget",
      criterionResults: [],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      verdict: "not_verified",
    });
  });

  it("rejects tampered immutable evidence before completion", async () => {
    const fixture = await createRun();
    const support = await recordSupportedCriterion(fixture);
    await fixture.verdicts.set({
      classification: "pass",
      summary: "Login should fail integrity verification",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: [support.assertion.id],
          evidenceIds: [support.evidence.id],
        },
      ],
    });
    await writeFile(
      join(fixture.projectRoot, support.evidence.projectRelativePath),
      Buffer.from([9, 9, 9]),
    );
    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });
});

describe("run lifecycle", () => {
  it("rejects protocol, verdict, and finalization mutation while interrupted", async () => {
    const fixture = await createRun();
    const action = await fixture.protocol.planAction({
      idempotencyKey: "before-interruption",
      kind: "observation",
      intent: "Record one completed action before interruption",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    await fixture.protocol.completeAction({
      actionId: action.id,
      phase: "completed",
      toolResult: { summary: "Observed before interruption" },
    });
    const capture = await fixture.protocol.planAction({
      idempotencyKey: "capture-before-interruption",
      kind: "evidence-capture",
      intent: "Prepare evidence before interruption",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    await fixture.protocol.completeAction({
      actionId: capture.id,
      phase: "completed",
      toolResult: { summary: "Captured before interruption" },
    });
    const interruptedSource = join(fixture.projectRoot, "interrupted.png");
    await writeFile(interruptedSource, Buffer.from([1, 3, 3, 7]));
    const verdict = await fixture.verdicts.set({
      classification: "not_verified",
      reasonCode: "incomplete_coverage",
      summary: "Coverage was incomplete before interruption",
      criterionResults: [],
    });
    await appendInterrupted(fixture);

    await expect(
      fixture.protocol.planAction({
        idempotencyKey: "while-interrupted",
        kind: "observation",
        intent: "Must resume before new protocol work",
        tool: "chrome-devtools-mcp",
        target: { description: "Current page" },
      }),
    ).rejects.toMatchObject({ code: "run.interrupted" });
    await expect(
      fixture.verdicts.revise({
        classification: "not_verified",
        reasonCode: "incomplete_coverage",
        summary: "Must resume before revising",
        criterionResults: [],
        supersedes: verdict.id,
      }),
    ).rejects.toMatchObject({ code: "run.interrupted" });
    await expect(
      registerEvidence({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        payload: {
          sourcePath: interruptedSource,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId: capture.id,
          idempotencyKey: "evidence-while-interrupted",
        },
        criterionIds: [],
        observationIds: [],
        now,
      }),
    ).rejects.toMatchObject({ code: "run.interrupted" });
    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "run.interrupted" });
    await expect(
      cancelRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        reason: "Cancel the durably interrupted run",
        now,
      }),
    ).resolves.toEqual({
      runId: "run-1",
      status: "cancelled",
      verdict: "not_verified",
    });
  });

  it("rejects interrupted to completed lifecycle history", async () => {
    const fixture = await createRun();
    const action = await fixture.protocol.planAction({
      idempotencyKey: "before-invalid-completion",
      kind: "observation",
      intent: "Complete one action before interruption",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    await fixture.protocol.completeAction({
      actionId: action.id,
      phase: "completed",
      toolResult: { summary: "Observed before interruption" },
    });
    const verdict = await fixture.verdicts.set({
      classification: "not_verified",
      reasonCode: "incomplete_coverage",
      summary: "Coverage remained incomplete",
      criterionResults: [],
    });
    await appendInterrupted(fixture);
    await fixture.repository.journal("run-1").append({
      type: "run",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "finish:run-1",
      payload: { phase: "completed", verdictId: verdict.id },
      relatedIds: [verdict.id],
    });

    await expect(
      readRunState({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
  });

  it("verifies immutable evidence before resuming", async () => {
    const fixture = await createRun();
    const support = await recordSupportedCriterion(fixture);
    await writeFile(
      join(fixture.projectRoot, support.evidence.projectRelativePath),
      Buffer.from([8, 8, 8]),
    );

    await expect(
      resumeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });

  it("rejects duplicate evidence index records before resuming", async () => {
    const fixture = await createRun();
    await recordSupportedCriterion(fixture);
    const indexPath = join(
      fixture.projectRoot,
      ".ai-qa",
      "evidence",
      "run-1",
      "index.jsonl",
    );
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, `${index}${index}`);

    await expect(
      resumeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });

    const phases = (await fixture.repository.journal("run-1").readAll())
      .filter((event) => event.type === "run")
      .map((event) => (event.payload as { phase: string }).phase);
    expect(phases).toEqual(["started"]);
  });

  it("classifies duplicate typed evidence before resuming", async () => {
    const fixture = await createRun();
    await recordSupportedCriterion(fixture);
    await appendDuplicateTypedEvidenceEvent(fixture);

    await expect(
      resumeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });

    const phases = (await fixture.repository.journal("run-1").readAll())
      .filter((event) => event.type === "run")
      .map((event) => (event.payload as { phase: string }).phase);
    expect(phases).toEqual(["started"]);
  });

  it("keeps duplicate typed evidence fatal for normal protocol mutation", async () => {
    const fixture = await createRun();
    await recordSupportedCriterion(fixture);
    await appendDuplicateTypedEvidenceEvent(fixture);

    await expect(
      fixture.protocol.planAction({
        idempotencyKey: "plan-after-duplicate-evidence",
        kind: "observation",
        intent: "Observe after duplicate evidence corruption",
        tool: "chrome-devtools-mcp",
        target: { description: "Current page" },
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
  });

  it("requires a fresh observation after resume before interaction", async () => {
    const fixture = await createRun();

    await expect(
      resumeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).resolves.toEqual({
      runId: "run-1",
      status: "running",
      requiresFreshObservation: true,
    });
    await expect(
      fixture.protocol.planAction({
        idempotencyKey: "click-before-observe",
        kind: "interaction",
        intent: "Click before observing resumed state",
        tool: "chrome-devtools-mcp",
        target: { description: "Login button" },
      }),
    ).rejects.toMatchObject({ code: "run.fresh_observation_required" });

    const observationAction = await fixture.protocol.planAction({
      idempotencyKey: "observe-after-resume",
      kind: "observation",
      intent: "Observe state after resume",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    await fixture.protocol.completeAction({
      actionId: observationAction.id,
      phase: "completed",
      toolResult: { summary: "Observed current page after resume" },
    });
    await fixture.protocol.addObservation({
      actionId: observationAction.id,
      summary: "Fresh state observed",
      state: { url: "https://example.com/login" },
    });
    await expect(
      fixture.protocol.planAction({
        idempotencyKey: "click-after-observe",
        kind: "interaction",
        intent: "Continue after observing resumed state",
        tool: "chrome-devtools-mcp",
        target: { description: "Login button" },
      }),
    ).resolves.toMatchObject({ type: "action" });

    const phases = (await fixture.repository.journal("run-1").readAll())
      .filter((event) => event.type === "run")
      .map((event) => (event.payload as { phase: string }).phase);
    expect(phases).toEqual(["started", "interrupted", "resumed"]);
  });

  it("cancels with a terminal not_verified verdict outside finalization", async () => {
    const fixture = await createRun();

    await expect(
      cancelRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        reason: "User stopped exploratory QA",
        now,
      }),
    ).resolves.toEqual({
      runId: "run-1",
      status: "cancelled",
      verdict: "not_verified",
    });
    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "run.cancelled" });
    await expect(
      resumeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "run.terminal" });

    const events = await fixture.repository.journal("run-1").readAll();
    const verdict = events.find((event) => event.type === "verdict");
    expect(verdict?.payload).toMatchObject({
      classification: "not_verified",
      reasonCode: "cancelled",
      summary: "User stopped exploratory QA",
    });
    expect(events.at(-1)?.payload).toMatchObject({
      phase: "cancelled",
      verdictId: verdict?.id,
      reason: "User stopped exploratory QA",
    });
  });

  it("rejects a historical cancellation verdict with criterion citations", async () => {
    const fixture = await createRun();
    const payload = {
      classification: "not_verified" as const,
      reasonCode: "cancelled" as const,
      summary: "Forged historical cancellation",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied" as const,
          assertionIds: ["event-forged"],
          evidenceIds: ["evidence-forged"],
        },
      ],
    };
    await fixture.repository.journal("run-1").append({
      type: "verdict",
      actor: "agent",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: `verdict:${sha256Canonical(payload)}`,
      payload,
      relatedIds: ["event-forged", "evidence-forged"],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
  });
});

describe("preflight result runs", () => {
  it("completes a failed controller preflight as blocked:tool", async () => {
    const fixture = await createPreflightProject();

    const result = await createPreflightResultRun({
      ...fixture,
      kind: "exploratory",
      exploratoryPayload: {
        goal: "Verify successful login",
        acceptanceCriteria: [
          {
            id: "authenticated-home-visible",
            description: "Authenticated home is visible",
            requiredEvidence: ["post-action-screenshot"],
          },
        ],
        readiness: {
          platform: "web",
          status: "not_ready",
          checks: [
            {
              code: "web.chrome_devtools_mcp",
              status: "fail",
              message: "Chrome DevTools MCP is unavailable",
              category: "tool",
            },
          ],
        },
      },
      execution: "local",
      readiness: {
        platform: "web",
        status: "not_ready",
        checks: [
          {
            code: "web.chrome_devtools_mcp",
            status: "fail",
            message: "Chrome DevTools MCP is unavailable",
            category: "tool",
          },
        ],
      },
      now,
    });

    expect(result).toMatchObject({
      status: "completed",
      verdict: "blocked",
      blockerSubtype: "tool",
    });
    expect(result).not.toHaveProperty("workOrder");
    const repository = new RunRepository(fixture.projectRoot, now);
    const workOrder = await repository.readVerifiedWorkOrder(result.runId);
    expect(workOrder.readiness.status).toBe("not_ready");
    const events = await repository.journal(result.runId).readAll();
    expect(events.map((event) => event.type)).toEqual([
      "run",
      "blocker",
      "verdict",
      "run",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ phase: "completed" });
  });

  it("completes confirmation-only preflight as not_verified", async () => {
    const fixture = await createPreflightProject();
    const readiness = {
      platform: "web" as const,
      status: "not_ready" as const,
      checks: [
        {
          code: "web.chrome_devtools_mcp" as const,
          status: "agent_confirmation_required" as const,
          message: "Agent must confirm MCP capability",
          category: "tool" as const,
        },
      ],
    };

    const result = await createPreflightResultRun({
      ...fixture,
      kind: "exploratory",
      exploratoryPayload: {
        goal: "Verify successful login",
        acceptanceCriteria: [
          {
            id: "authenticated-home-visible",
            description: "Authenticated home is visible",
            requiredEvidence: ["post-action-screenshot"],
          },
        ],
        readiness,
      },
      execution: "local",
      readiness,
      now,
    });

    expect(result).toMatchObject({
      status: "completed",
      verdict: "not_verified",
      reasonCode: "incomplete_coverage",
    });
    expect(result).not.toHaveProperty("workOrder");
    const repository = new RunRepository(fixture.projectRoot, now);
    const events = await repository.journal(result.runId).readAll();
    expect(events.map((event) => event.type)).toEqual([
      "run",
      "verdict",
      "run",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ phase: "completed" });
  });
});

describe("verdict and lifecycle CLI", () => {
  it.each([
    {
      name: "filesystem",
      failure: Object.assign(new Error("private path /private/project"), {
        code: "EIO",
        syscall: "write",
        path: "/private/project/output.json",
        input: "private input",
      }),
      expected: {
        code: "filesystem.operation_failed",
        message: "A filesystem operation failed",
        details: { code: "EIO", syscall: "write" },
      },
    },
    {
      name: "non-system",
      failure: new Error("private internal detail"),
      expected: {
        code: "internal.unexpected_error",
        message: "An unexpected internal error occurred",
        details: {},
      },
    },
  ])(
    "normalizes an unknown $name failure into one JSON response",
    async ({ failure, expected }) => {
      const captured = createCapturedCli({
        writeStdout: () => {
          throw failure;
        },
      });

      const exitCode = await runCli(["--version"], captured.context);

      expect(exitCode).toBe(1);
      expect(captured.stdout).toEqual([]);
      expect(captured.stderr).toHaveLength(1);
      expect(captured.stderr[0]?.endsWith("\n")).toBe(true);
      expect(JSON.parse(captured.stderr[0]!)).toEqual({ error: expected });
      expect(captured.stderr[0]).not.toContain("private");
      expect(captured.stderr[0]?.toLowerCase()).not.toContain("stack");
    },
  );

  it("returns one structured JSON error for a missing run", async () => {
    const fixture = await createPreflightProject();
    const captured = createCapturedCli({
      cwd: fixture.projectRoot,
      now,
    });

    const exitCode = await runCli(
      ["--project", fixture.projectRoot, "run", "finish", "run-missing"],
      captured.context,
    );

    expect(exitCode).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toHaveLength(1);
    expect(captured.stderr.join("").endsWith("\n")).toBe(true);
    expect(JSON.parse(captured.stderr.join(""))).toEqual({
      error: {
        code: "run.not_found",
        message: "Run does not exist",
        details: { runId: "run-missing" },
      },
    });
    expect(captured.stderr.join("").toLowerCase()).not.toContain("stack");
  });

  it("does not advertise finish while an action is incomplete", async () => {
    const fixture = await createRun();
    await fixture.protocol.planAction({
      idempotencyKey: "pending-before-verdict",
      kind: "observation",
      intent: "Leave this action pending",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    await fixture.verdicts.set({
      classification: "not_verified",
      reasonCode: "incomplete_coverage",
      summary: "Coverage and action completion are pending",
      criterionResults: [],
    });

    const state = await readRunState({
      projectRoot: fixture.projectRoot,
      runId: "run-1",
      now,
    });
    expect(state.permittedNextActions).toEqual([
      "invoke-tool",
      "action.complete",
      "verdict.revise",
    ]);
  });

  it("advertises verdict set after assertion coverage is recorded", async () => {
    const fixture = await createRun();
    await recordSupportedCriterion(fixture);

    const state = await readRunState({
      projectRoot: fixture.projectRoot,
      runId: "run-1",
      now,
    });
    expect(state.permittedNextActions).toContain("verdict.set");
  });

  it("records a blocker and verdict, then finishes with state-aware hints", async () => {
    const fixture = await createRun();
    const attempt = await fixture.protocol.planAction({
      idempotencyKey: "attempt-web-control",
      kind: "observation",
      intent: "Attempt to inspect the current Web state",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
    });
    const terminalAttempt = await fixture.protocol.completeAction({
      actionId: attempt.id,
      phase: "completed",
      toolResult: { summary: "Chrome DevTools MCP disconnected" },
    });
    let stdin = JSON.stringify({
      subtype: "tool",
      condition: "Chrome DevTools MCP disconnected",
      attemptEventIds: [terminalAttempt.id],
      criterionIds: [],
    });
    const captured = createCapturedCli({
      cwd: fixture.projectRoot,
      now,
      readStdin: () => Promise.resolve(stdin),
    });

    const blockerExit = await runCli(
      [
        "--project",
        fixture.projectRoot,
        "blocker",
        "record",
        "--run",
        "run-1",
        "--stdin-json",
      ],
      captured.context,
    );
    expect(captured.stderr).toEqual([]);
    expect(blockerExit).toBe(0);
    const blocker = JSON.parse(captured.stdout.pop()!) as { eventId: string };
    stdin = JSON.stringify({
      classification: "blocked",
      blockerSubtype: "tool",
      blockerIds: [blocker.eventId],
      summary: "Web control is unavailable",
      criterionResults: [],
    });

    expect(
      await runCli(
        [
          "--project",
          fixture.projectRoot,
          "verdict",
          "set",
          "--run",
          "run-1",
          "--stdin-json",
        ],
        captured.context,
      ),
    ).toBe(0);
    const initialVerdict = JSON.parse(captured.stdout.pop()!) as {
      eventId: string;
      state: { status: string; effectiveVerdict: string };
      permittedNextActions: string[];
    };
    expect(initialVerdict).toMatchObject({
      state: { status: "running", effectiveVerdict: "blocked" },
      permittedNextActions: ["run.finish", "verdict.revise"],
    });
    stdin = JSON.stringify({
      classification: "blocked",
      blockerSubtype: "tool",
      blockerIds: [blocker.eventId],
      summary: "Web control remains unavailable after review",
      criterionResults: [],
    });
    expect(
      await runCli(
        [
          "--project",
          fixture.projectRoot,
          "verdict",
          "revise",
          "--run",
          "run-1",
          "--supersedes",
          initialVerdict.eventId,
          "--stdin-json",
        ],
        captured.context,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.pop()!)).toMatchObject({
      state: { status: "running", effectiveVerdict: "blocked" },
      permittedNextActions: ["run.finish", "verdict.revise"],
    });

    expect(
      await runCli(
        ["--project", fixture.projectRoot, "run", "finish", "run-1"],
        captured.context,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.pop()!)).toMatchObject({
      runId: "run-1",
      status: "completed",
      verdict: "blocked",
      permittedNextActions: ["report.generate"],
    });
  });

  it("resumes and cancels with lifecycle-derived next actions", async () => {
    const fixture = await createRun();
    const captured = createCapturedCli({
      cwd: fixture.projectRoot,
      now,
    });

    const resumeExit = await runCli(
      ["--project", fixture.projectRoot, "run", "resume", "run-1"],
      captured.context,
    );
    expect(captured.stderr).toEqual([]);
    expect(resumeExit).toBe(0);
    expect(JSON.parse(captured.stdout.pop()!)).toMatchObject({
      runId: "run-1",
      status: "running",
      requiresFreshObservation: true,
      permittedNextActions: ["action.plan:observation"],
    });

    expect(
      await runCli(
        [
          "run",
          "cancel",
          "run-1",
          "--project",
          fixture.projectRoot,
          "--reason",
          "User stopped exploratory QA",
        ],
        captured.context,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.pop()!)).toMatchObject({
      runId: "run-1",
      status: "cancelled",
      verdict: "not_verified",
      permittedNextActions: ["report.generate"],
    });
  });
});
