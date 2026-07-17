import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { CaseRepository } from "../../src/core/cases/repository.js";
import {
  calculateCaseContentHash,
  calculateWebVariantHash,
  type CaseRevision,
} from "../../src/core/cases/schema.js";
import { writeProjectConfig } from "../../src/core/config/repository.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import type { WebDoctorResult } from "../../src/services/doctor/web-doctor.js";
import { createPreflightResultRun } from "../../src/services/run-protocol/create-preflight-result-run.js";
import { finalizeRun } from "../../src/services/run-protocol/finalize-run.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { startRegressionRun } from "../../src/services/run-protocol/start-regression-run.js";
import { VerdictService } from "../../src/services/run-protocol/verdict-service.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import { initializeTestProject } from "../helpers/project-fixture.js";

const startedAt = new Date("2026-07-13T00:00:00.000Z");
const now = () => new Date("2026-07-13T00:01:00.000Z");
const ready: WebDoctorResult = {
  platform: "web",
  status: "ready",
  checks: [
    { code: "web.entry_url", status: "pass", message: "Configured" },
    {
      code: "web.entry_page",
      status: "pass",
      message: "Entry page is ready",
    },
    {
      code: "web.chrome_devtools_mcp",
      status: "pass",
      message: "Chrome DevTools MCP is ready",
    },
    {
      code: "agent.global_skill",
      status: "pass",
      message: "Global skill is compatible",
    },
  ],
};
const config: ProjectConfig = {
  schemaVersion: 2,
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

interface RegressionFixture {
  projectRoot: string;
  revision: CaseRevision;
}

async function createActiveCase(
  options: { firstEvidenceCheckpoints?: string[] } = {},
): Promise<RegressionFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-replay-project-"));
  await initializeTestProject({ projectRoot, config });
  const cases = new CaseRepository(projectRoot, now);
  const revision = await cases.createDraft({
    schemaVersion: 1,
    caseId: "login-success",
    title: "Successful login",
    promotion: { sourceRunId: "run-source", validationIssues: [] },
    acceptanceCriteria: [
      {
        id: "home-visible",
        description: "Authenticated home is visible",
        requiredEvidence: ["post-action-screenshot"],
      },
      {
        id: "account-visible",
        description: "Current account is visible",
        requiredEvidence: ["post-action-screenshot"],
      },
    ],
    variants: {
      web: {
        steps: [
          {
            id: "step-1-submit-login",
            sourceActionId: "event-source-login",
            intent: "Submit valid credentials",
            tool: "chrome-devtools-mcp",
            target: {
              description: "Login button",
              selector: '[data-testid="login"]',
              stability: "stable",
              stabilityRationale: "Unique application-owned data-testid",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "Observe the authenticated home",
            evidenceCheckpoints: options.firstEvidenceCheckpoints ?? [
              "post-action-screenshot",
            ],
          },
          {
            id: "step-2-account-visible",
            sourceActionId: "event-source-account",
            intent: "Assert account",
            tool: "chrome-devtools-mcp",
            target: {
              description: "Account label",
              selector: '[data-testid="account"]',
              stability: "stable",
              stabilityRationale: "Unique application-owned data-testid",
            },
            expectedState: "Current account is visible",
            assertionStrategy: "Read the visible account label",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
      },
    },
  });
  await cases.activate("login-success", revision.revision, {
    confirmedBy: "user",
    confirmedAt: startedAt.toISOString(),
  });
  return { projectRoot, revision };
}

async function startFixtureRun(fixture: RegressionFixture) {
  const workOrder = await startRegressionRun({
    projectRoot: fixture.projectRoot,
    caseId: "login-success",
    execution: "local",
    readiness: ready,
    now: () => startedAt,
  });
  return {
    workOrder,
    protocol: new RunProtocolService(
      fixture.projectRoot,
      workOrder.runId,
      now,
    ),
  };
}

async function completeStep(input: {
  fixture: RegressionFixture;
  runId: string;
  protocol: RunProtocolService;
  stepId: string;
  criterionId: string;
  key: string;
  skipAssertion?: boolean;
}) {
  const required =
    input.stepId === "step-1-submit-login"
      ? {
          intent: "Submit valid credentials",
          target: {
            description: "Login button",
            selector: '[data-testid="login"]',
          },
        }
      : {
          intent: "Assert account",
          target: {
            description: "Account label",
            selector: '[data-testid="account"]',
          },
        };
  const interaction = await input.protocol.planAction({
    idempotencyKey: `${input.key}-interaction`,
    kind: "interaction",
    intent: required.intent,
    tool: "chrome-devtools-mcp",
    target: required.target,
    stepId: input.stepId,
  });
  await input.protocol.completeAction({
    actionId: interaction.id,
    phase: "completed",
    toolResult: { summary: `${input.stepId} completed` },
  });
  const observationAction = await input.protocol.planAction({
    idempotencyKey: `${input.key}-observe`,
    kind: "observation",
    intent: `Observe ${input.stepId}`,
    tool: "chrome-devtools-mcp",
    target: { description: "Current page" },
    stepId: input.stepId,
  });
  await input.protocol.completeAction({
    actionId: observationAction.id,
    phase: "completed",
    toolResult: { summary: `${input.stepId} observed` },
  });
  const observation = await input.protocol.addObservation({
    actionId: observationAction.id,
    summary: `${input.stepId} expected state is visible`,
    state: { visible: true },
  });
  const capture = await input.protocol.planAction({
    idempotencyKey: `${input.key}-capture`,
    kind: "evidence-capture",
    intent: `Capture ${input.stepId}`,
    tool: "chrome-devtools-mcp",
    target: { description: "Current page" },
    stepId: input.stepId,
  });
  await input.protocol.completeAction({
    actionId: capture.id,
    phase: "completed",
    toolResult: { summary: `${input.stepId} screenshot captured` },
  });
  const sourcePath = join(input.fixture.projectRoot, `${input.key}.png`);
  await writeFile(sourcePath, Buffer.from([1, 2, 3, input.key.length]));
  const evidence = await registerEvidence({
    projectRoot: input.fixture.projectRoot,
    runId: input.runId,
    payload: {
      sourcePath,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: capture.id,
      idempotencyKey: `${input.key}-evidence`,
    },
    criterionIds: [input.criterionId],
    observationIds: [observation.id],
    now,
  });
  const assertion =
    input.skipAssertion === true
      ? undefined
      : await input.protocol.recordAssertion({
          criterionId: input.criterionId,
          status: "satisfied",
          assertionKinds: ["semantic-ui"],
          actual: `${input.stepId} expected state is visible`,
          expected: `${input.stepId} expected state is visible`,
          observationIds: [observation.id],
          evidenceIds: [evidence.id],
          stepId: input.stepId,
        });
  return { interaction, observation, evidence, assertion };
}

describe("pinned regression replay", () => {
  it("pins the active case and rejects a prospective out-of-order step", async () => {
    const fixture = await createActiveCase();
    const { workOrder, protocol } = await startFixtureRun(fixture);

    expect(workOrder).toMatchObject({
      kind: "regression",
      goal: "Successful login",
      requiredSteps: [
        { id: "step-1-submit-login", order: 0 },
        { id: "step-2-account-visible", order: 1 },
      ],
      pinnedCase: {
        caseId: "login-success",
        revision: fixture.revision.revision,
        caseContentHash: calculateCaseContentHash(fixture.revision),
        platformVariantHash: calculateWebVariantHash(fixture.revision),
      },
    });
    await expect(
      protocol.planAction({
        idempotencyKey: "skip-to-account",
        kind: "interaction",
        intent: "Assert account",
        tool: "chrome-devtools-mcp",
        target: { description: "Account label" },
        stepId: "step-2-account-visible",
      }),
    ).rejects.toMatchObject({ code: "replay.step_out_of_order" });
  });

  it("completes an ordered replay with step-linked observations and evidence", async () => {
    const fixture = await createActiveCase();
    const { workOrder, protocol } = await startFixtureRun(fixture);
    const first = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-1-submit-login",
      criterionId: "home-visible",
      key: "home",
    });
    const second = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-2-account-visible",
      criterionId: "account-visible",
      key: "account",
    });
    await new VerdictService(
      fixture.projectRoot,
      workOrder.runId,
      now,
    ).set({
      classification: "pass",
      summary: "Both required states are supported",
      criterionResults: [
        {
          criterionId: "home-visible",
          status: "satisfied",
          assertionIds: [first.assertion!.id],
          evidenceIds: [first.evidence.id],
        },
        {
          criterionId: "account-visible",
          status: "satisfied",
          assertionIds: [second.assertion!.id],
          evidenceIds: [second.evidence.id],
        },
      ],
    });

    const completed = await finalizeRun({
      projectRoot: fixture.projectRoot,
      runId: workOrder.runId,
      now,
    });
    expect(completed).toMatchObject({ status: "completed", verdict: "pass" });
    const revisionPath = join(
      fixture.projectRoot,
      ".ai-qa",
      "cases",
      "login-success",
      "revisions",
      `${String(fixture.revision.revision)}.yaml`,
    );
    await writeFile(revisionPath, "tampered after accepted completion");
    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: workOrder.runId,
        now,
      }),
    ).resolves.toEqual(completed);
  });

  it("rejects replay completion when a required step checkpoint is not linked", async () => {
    const fixture = await createActiveCase({
      firstEvidenceCheckpoints: ["structured-step-checkpoint"],
    });
    const { workOrder, protocol } = await startFixtureRun(fixture);
    const first = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-1-submit-login",
      criterionId: "home-visible",
      key: "missing-checkpoint-home",
    });
    const second = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-2-account-visible",
      criterionId: "account-visible",
      key: "missing-checkpoint-account",
    });
    await new VerdictService(
      fixture.projectRoot,
      workOrder.runId,
      now,
    ).set({
      classification: "pass",
      summary: "Criterion evidence exists but one pinned checkpoint is absent",
      criterionResults: [
        {
          criterionId: "home-visible",
          status: "satisfied",
          assertionIds: [first.assertion!.id],
          evidenceIds: [first.evidence.id],
        },
        {
          criterionId: "account-visible",
          status: "satisfied",
          assertionIds: [second.assertion!.id],
          evidenceIds: [second.evidence.id],
        },
      ],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: workOrder.runId,
        now,
      }),
    ).rejects.toMatchObject({ code: "replay.fidelity_incomplete" });
  });

  it("does not satisfy a checkpoint with a linked violated assertion", async () => {
    const fixture = await createActiveCase({
      firstEvidenceCheckpoints: [
        "structured-text-assertion",
        "post-action-screenshot",
      ],
    });
    const { workOrder, protocol } = await startFixtureRun(fixture);
    const first = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-1-submit-login",
      criterionId: "home-visible",
      key: "violated-checkpoint-home",
      skipAssertion: true,
    });
    await protocol.recordAssertion({
      criterionId: "home-visible",
      status: "violated",
      assertionKinds: ["structured-text-assertion"],
      actual: "Authenticated account text is absent",
      expected: "Authenticated account text is visible",
      observationIds: [first.observation.id],
      evidenceIds: [first.evidence.id],
      stepId: "step-1-submit-login",
    });
    const supported = await protocol.recordAssertion({
      criterionId: "home-visible",
      status: "satisfied",
      assertionKinds: ["semantic-ui"],
      actual: "Authenticated home is visible",
      expected: "Authenticated home is visible",
      observationIds: [first.observation.id],
      evidenceIds: [first.evidence.id],
      stepId: "step-1-submit-login",
    });
    const second = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-2-account-visible",
      criterionId: "account-visible",
      key: "violated-checkpoint-account",
    });
    await new VerdictService(
      fixture.projectRoot,
      workOrder.runId,
      now,
    ).set({
      classification: "pass",
      summary: "A violated assertion cannot provide the pinned checkpoint",
      criterionResults: [
        {
          criterionId: "home-visible",
          status: "satisfied",
          assertionIds: [supported.id],
          evidenceIds: [first.evidence.id],
        },
        {
          criterionId: "account-visible",
          status: "satisfied",
          assertionIds: [second.assertion!.id],
          evidenceIds: [second.evidence.id],
        },
      ],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: workOrder.runId,
        now,
      }),
    ).rejects.toMatchObject({ code: "replay.fidelity_incomplete" });
  });

  it("rejects a pass whose assertion is attributed to the wrong required step", async () => {
    const fixture = await createActiveCase();
    const { workOrder, protocol } = await startFixtureRun(fixture);
    const first = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-1-submit-login",
      criterionId: "home-visible",
      key: "misattributed-home",
      skipAssertion: true,
    });
    const second = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-2-account-visible",
      criterionId: "account-visible",
      key: "misattributed-account",
    });
    const misattributed = await protocol.recordAssertion({
      criterionId: "home-visible",
      status: "satisfied",
      assertionKinds: ["semantic-ui"],
      actual: "Authenticated home is visible",
      expected: "Authenticated home is visible",
      observationIds: [first.observation.id],
      evidenceIds: [first.evidence.id],
      stepId: "step-2-account-visible",
    });
    await new VerdictService(
      fixture.projectRoot,
      workOrder.runId,
      now,
    ).set({
      classification: "pass",
      summary: "The home assertion is attributed to the wrong pinned step",
      criterionResults: [
        {
          criterionId: "home-visible",
          status: "satisfied",
          assertionIds: [misattributed.id],
          evidenceIds: [first.evidence.id],
        },
        {
          criterionId: "account-visible",
          status: "satisfied",
          assertionIds: [second.assertion!.id],
          evidenceIds: [second.evidence.id],
        },
      ],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: workOrder.runId,
        now,
      }),
    ).rejects.toMatchObject({ code: "replay.fidelity_incomplete" });
  });

  it("rejects checkpoint records laundered from pre-step tool calls", async () => {
    const fixture = await createActiveCase();
    const { workOrder, protocol } = await startFixtureRun(fixture);
    const earlyObservationAction = await protocol.planAction({
      idempotencyKey: "early-home-observation",
      kind: "observation",
      intent: "Observe before submitting login",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: earlyObservationAction.id,
      phase: "completed",
      toolResult: { summary: "Pre-login page observed" },
    });
    const earlyCapture = await protocol.planAction({
      idempotencyKey: "early-home-capture",
      kind: "evidence-capture",
      intent: "Capture before submitting login",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: earlyCapture.id,
      phase: "completed",
      toolResult: { summary: "Pre-login screenshot captured" },
    });
    const interaction = await protocol.planAction({
      idempotencyKey: "laundered-login-interaction",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: {
        description: "Login button",
        selector: '[data-testid="login"]',
      },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: interaction.id,
      phase: "completed",
      toolResult: { summary: "Login submitted" },
    });
    const lateObservationRecord = await protocol.addObservation({
      actionId: earlyObservationAction.id,
      summary: "Late record claims authenticated home is visible",
      state: { visible: true },
    });
    const sourcePath = join(fixture.projectRoot, "laundered-home.png");
    await writeFile(sourcePath, Buffer.from([9, 8, 7, 6]));
    const launderedEvidence = await registerEvidence({
      projectRoot: fixture.projectRoot,
      runId: workOrder.runId,
      payload: {
        sourcePath,
        mediaType: "image/png",
        sourceTool: "chrome-devtools-mcp",
        sensitivity: "internal",
        evidenceKinds: ["post-action-screenshot"],
        captureActionId: earlyCapture.id,
        idempotencyKey: "laundered-home-evidence",
      },
      criterionIds: ["home-visible"],
      observationIds: [lateObservationRecord.id],
      now,
    });
    const firstAssertion = await protocol.recordAssertion({
      criterionId: "home-visible",
      status: "satisfied",
      assertionKinds: ["semantic-ui"],
      actual: "Authenticated home is visible",
      expected: "Authenticated home is visible",
      observationIds: [lateObservationRecord.id],
      evidenceIds: [launderedEvidence.id],
      stepId: "step-1-submit-login",
    });
    const second = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-2-account-visible",
      criterionId: "account-visible",
      key: "laundered-account",
    });
    await new VerdictService(
      fixture.projectRoot,
      workOrder.runId,
      now,
    ).set({
      classification: "pass",
      summary: "Records were appended late but their tool calls were stale",
      criterionResults: [
        {
          criterionId: "home-visible",
          status: "satisfied",
          assertionIds: [firstAssertion.id],
          evidenceIds: [launderedEvidence.id],
        },
        {
          criterionId: "account-visible",
          status: "satisfied",
          assertionIds: [second.assertion!.id],
          evidenceIds: [second.evidence.id],
        },
      ],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: workOrder.runId,
        now,
      }),
    ).rejects.toMatchObject({ code: "replay.fidelity_incomplete" });
  });

  it("rejects an unmarked recovery interaction", async () => {
    const fixture = await createActiveCase();
    const { protocol } = await startFixtureRun(fixture);
    const interaction = await protocol.planAction({
      idempotencyKey: "ambiguous-login",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: {
        description: "Login button",
        selector: '[data-testid="login"]',
      },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: interaction.id,
      phase: "unknown",
      toolResult: { summary: "The result is ambiguous" },
    });
    const observationAction = await protocol.planAction({
      idempotencyKey: "observe-ambiguous-login",
      kind: "observation",
      intent: "Observe the ambiguous login result",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: observationAction.id,
      phase: "completed",
      toolResult: { summary: "Current state observed" },
    });
    const observation = await protocol.addObservation({
      actionId: observationAction.id,
      summary: "Login was not applied",
      state: { applied: false },
    });
    await protocol.resolveUnknownAction({
      actionId: interaction.id,
      resolution: "not_applied",
      observationId: observation.id,
      rationale: "The login form remains unchanged",
    });

    await expect(
      protocol.planAction({
        idempotencyKey: "retry-without-marker",
        kind: "interaction",
        intent: "Retry login",
        tool: "chrome-devtools-mcp",
        target: {
          description: "Login button",
          selector: '[data-testid="login"]',
        },
        stepId: "step-1-submit-login",
      }),
    ).rejects.toMatchObject({ code: "recovery.marker_required" });
  });

  it("rejects cross-step regression recovery without authorizing retry", async () => {
    const fixture = await createActiveCase();
    const { protocol } = await startFixtureRun(fixture);
    const first = await protocol.planAction({
      idempotencyKey: "complete-first-before-cross-step-recovery",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: {
        description: "Login button",
        selector: '[data-testid="login"]',
      },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: first.id,
      phase: "completed",
      toolResult: { summary: "Login completed" },
    });
    const second = await protocol.planAction({
      idempotencyKey: "cross-step-regression-unknown",
      kind: "interaction",
      intent: "Assert account",
      tool: "chrome-devtools-mcp",
      target: {
        description: "Account label",
        selector: '[data-testid="account"]',
      },
      stepId: "step-2-account-visible",
    });
    await protocol.completeAction({
      actionId: second.id,
      phase: "unknown",
      toolResult: { summary: "The account assertion result is ambiguous" },
    });
    const observationAction = await protocol.planAction({
      idempotencyKey: "observe-previous-regression-step",
      kind: "observation",
      intent: "Observe the prior login step",
      tool: "chrome-devtools-mcp",
      target: { description: "Authenticated home" },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: observationAction.id,
      phase: "completed",
      toolResult: { summary: "Observed the authenticated home" },
    });
    const observation = await protocol.addObservation({
      actionId: observationAction.id,
      summary: "Authenticated home remains visible",
      state: { home: true },
    });

    await expect(
      protocol.resolveUnknownAction({
        actionId: second.id,
        resolution: "not_applied",
        observationId: observation.id,
        rationale: "The prior step cannot resolve the account assertion",
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
    await expect(
      protocol.planAction({
        idempotencyKey: "retry-after-cross-step-regression-recovery",
        kind: "interaction",
        intent: "Retry account assertion",
        tool: "chrome-devtools-mcp",
        target: { description: "Account label" },
        recoveryForStepId: "step-2-account-visible",
      }),
    ).rejects.toMatchObject({ code: "recovery.retry_not_permitted" });
  });

  it("does not let a completed recovery replace or advance a required step", async () => {
    const fixture = await createActiveCase();
    const { protocol } = await startFixtureRun(fixture);
    const interaction = await protocol.planAction({
      idempotencyKey: "unknown-login",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: {
        description: "Login button",
        selector: '[data-testid="login"]',
      },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: interaction.id,
      phase: "unknown",
      toolResult: { summary: "The result is ambiguous" },
    });
    const observationAction = await protocol.planAction({
      idempotencyKey: "observe-unknown-login",
      kind: "observation",
      intent: "Observe login state",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: observationAction.id,
      phase: "completed",
      toolResult: { summary: "Current state observed" },
    });
    const observation = await protocol.addObservation({
      actionId: observationAction.id,
      summary: "Login was not applied",
      state: { applied: false },
    });
    await protocol.resolveUnknownAction({
      actionId: interaction.id,
      resolution: "not_applied",
      observationId: observation.id,
      rationale: "The login form remains unchanged",
    });
    const recovery = await protocol.planAction({
      idempotencyKey: "recover-login-form",
      kind: "interaction",
      intent: "Restore the login form",
      tool: "chrome-devtools-mcp",
      target: { description: "Login form" },
      stepId: "step-1-submit-login",
      recoveryForStepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: recovery.id,
      phase: "completed",
      toolResult: { summary: "Login form restored" },
    });

    await expect(
      protocol.planAction({
        idempotencyKey: "advance-after-recovery",
        kind: "interaction",
        intent: "Assert account",
        tool: "chrome-devtools-mcp",
        target: { description: "Account label" },
        stepId: "step-2-account-visible",
      }),
    ).rejects.toMatchObject({ code: "replay.step_out_of_order" });

    const retry = await protocol.planAction({
      idempotencyKey: "retry-required-login",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: {
        description: "Login button",
        selector: '[data-testid="login"]',
      },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: retry.id,
      phase: "completed",
      toolResult: { summary: "Login completed after recovery" },
    });
    await expect(
      protocol.planAction({
        idempotencyKey: "advance-after-required-retry",
        kind: "interaction",
        intent: "Assert account",
        tool: "chrome-devtools-mcp",
        target: {
          description: "Account label",
          selector: '[data-testid="account"]',
        },
        stepId: "step-2-account-visible",
      }),
    ).resolves.toMatchObject({ type: "action" });
  });

  it("opens the normal retry when an ambiguous recovery resolves applied", async () => {
    const fixture = await createActiveCase();
    const { protocol } = await startFixtureRun(fixture);
    const interaction = await protocol.planAction({
      idempotencyKey: "unknown-login-before-ambiguous-recovery",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: {
        description: "Login button",
        selector: '[data-testid="login"]',
      },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: interaction.id,
      phase: "unknown",
      toolResult: { summary: "The login result is ambiguous" },
    });
    const initialObservationAction = await protocol.planAction({
      idempotencyKey: "observe-before-ambiguous-recovery",
      kind: "observation",
      intent: "Observe login state",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: initialObservationAction.id,
      phase: "completed",
      toolResult: { summary: "Login state observed" },
    });
    const initialObservation = await protocol.addObservation({
      actionId: initialObservationAction.id,
      summary: "The login action was not applied",
      state: { applied: false },
    });
    await protocol.resolveUnknownAction({
      actionId: interaction.id,
      resolution: "not_applied",
      observationId: initialObservation.id,
      rationale: "The login form remains unchanged",
    });
    const recovery = await protocol.planAction({
      idempotencyKey: "ambiguous-recovery",
      kind: "interaction",
      intent: "Restore the login form",
      tool: "chrome-devtools-mcp",
      target: { description: "Login form" },
      stepId: "step-1-submit-login",
      recoveryForStepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: recovery.id,
      phase: "unknown",
      toolResult: { summary: "The recovery result is ambiguous" },
    });
    const recoveryObservationAction = await protocol.planAction({
      idempotencyKey: "observe-ambiguous-recovery",
      kind: "observation",
      intent: "Observe recovery state",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: recoveryObservationAction.id,
      phase: "completed",
      toolResult: { summary: "Recovery state observed" },
    });
    const recoveryObservation = await protocol.addObservation({
      actionId: recoveryObservationAction.id,
      summary: "The recovery restored the login form",
      state: { recovered: true },
    });
    await protocol.resolveUnknownAction({
      actionId: recovery.id,
      resolution: "applied",
      observationId: recoveryObservation.id,
      rationale: "Fresh state confirms the recovery applied",
    });

    await expect(
      protocol.planAction({
        idempotencyKey: "advance-after-applied-recovery",
        kind: "interaction",
        intent: "Assert account",
        tool: "chrome-devtools-mcp",
        target: {
          description: "Account label",
          selector: '[data-testid="account"]',
        },
        stepId: "step-2-account-visible",
      }),
    ).rejects.toMatchObject({ code: "replay.step_out_of_order" });
    await expect(
      protocol.planAction({
        idempotencyKey: "retry-after-applied-recovery",
        kind: "interaction",
        intent: "Submit valid credentials",
        tool: "chrome-devtools-mcp",
        target: {
          description: "Login button",
          selector: '[data-testid="login"]',
        },
        stepId: "step-1-submit-login",
      }),
    ).resolves.toMatchObject({ type: "action" });
  });

  it("treats an applied resolution as confirmation of the original normal step", async () => {
    const fixture = await createActiveCase();
    const { protocol } = await startFixtureRun(fixture);
    const interaction = await protocol.planAction({
      idempotencyKey: "applied-login",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: {
        description: "Login button",
        selector: '[data-testid="login"]',
      },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: interaction.id,
      phase: "unknown",
      toolResult: { summary: "The direct result was ambiguous" },
    });
    const observationAction = await protocol.planAction({
      idempotencyKey: "observe-applied-login",
      kind: "observation",
      intent: "Observe login state",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: observationAction.id,
      phase: "completed",
      toolResult: { summary: "Current state observed" },
    });
    const observation = await protocol.addObservation({
      actionId: observationAction.id,
      summary: "Authenticated home confirms the original action applied",
      state: { applied: true },
    });
    await protocol.resolveUnknownAction({
      actionId: interaction.id,
      resolution: "applied",
      observationId: observation.id,
      rationale: "Fresh state confirms the original login was applied",
    });

    await expect(
      protocol.planAction({
        idempotencyKey: "advance-after-applied-resolution",
        kind: "interaction",
        intent: "Assert account",
        tool: "chrome-devtools-mcp",
        target: {
          description: "Account label",
          selector: '[data-testid="account"]',
        },
        stepId: "step-2-account-visible",
      }),
    ).resolves.toMatchObject({ type: "action" });
  });

  it("completes a typed runtime blocker without fabricating later required steps", async () => {
    const fixture = await createActiveCase();
    const { workOrder, protocol } = await startFixtureRun(fixture);
    const interaction = await protocol.planAction({
      idempotencyKey: "blocked-login",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: {
        description: "Login button",
        selector: '[data-testid="login"]',
      },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: interaction.id,
      phase: "unknown",
      toolResult: { summary: "Chrome DevTools stopped responding" },
    });
    const observationAction = await protocol.planAction({
      idempotencyKey: "observe-blocked-login",
      kind: "observation",
      intent: "Inspect state after the tool failure",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
      stepId: "step-1-submit-login",
    });
    await protocol.completeAction({
      actionId: observationAction.id,
      phase: "completed",
      toolResult: { summary: "State remained indeterminate" },
    });
    const observation = await protocol.addObservation({
      actionId: observationAction.id,
      summary: "The tool failure left login state indeterminate",
      state: { status: "indeterminate" },
    });
    await protocol.resolveUnknownAction({
      actionId: interaction.id,
      resolution: "indeterminate",
      observationId: observation.id,
      rationale: "The platform tool cannot establish whether login applied",
    });
    const verdicts = new VerdictService(
      fixture.projectRoot,
      workOrder.runId,
      now,
    );
    const blocker = await verdicts.recordBlocker({
      subtype: "tool",
      condition: "Chrome DevTools MCP stopped responding during step 1",
      attemptEventIds: [interaction.id],
      criterionIds: ["home-visible"],
    });
    await verdicts.set({
      classification: "blocked",
      blockerSubtype: "tool",
      blockerIds: [blocker.id],
      summary: "The regression could not continue after the tool failure",
      criterionResults: [],
    });

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: workOrder.runId,
        now,
      }),
    ).resolves.toMatchObject({ status: "completed", verdict: "blocked" });
  });

  it("pins the active revision into a zero-action regression preflight result", async () => {
    const fixture = await createActiveCase();
    const result = await createPreflightResultRun({
      projectRoot: fixture.projectRoot,
      kind: "regression",
      caseId: "login-success",
      execution: "ci",
      readiness: {
        ...ready,
        status: "not_ready",
        checks: ready.checks.map((check) =>
          check.code === "web.chrome_devtools_mcp"
            ? { ...check, status: "fail" as const, message: "MCP missing" }
            : check,
        ),
      },
      now,
    });
    const workOrder = await new RunRepository(
      fixture.projectRoot,
      now,
    ).readVerifiedWorkOrder(result.runId);

    expect(result).toMatchObject({
      status: "completed",
      verdict: "blocked",
      blockerSubtype: "tool",
    });
    expect(workOrder).toMatchObject({
      kind: "regression",
      execution: "ci",
      preflightResult: true,
      pinnedCase: {
        caseId: "login-success",
        revision: fixture.revision.revision,
        caseContentHash: calculateCaseContentHash(fixture.revision),
        platformVariantHash: calculateWebVariantHash(fixture.revision),
      },
    });
  });

  it("uses the gated config snapshot for a regression CLI preflight result", async () => {
    const fixture = await createActiveCase();
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-replay-agents-"));
    const notReady: WebDoctorResult = {
      ...ready,
      status: "not_ready",
      checks: ready.checks.map((check) =>
        check.code === "web.chrome_devtools_mcp"
          ? { ...check, status: "fail" as const, message: "MCP missing" }
          : check,
      ),
    };
    const captured = createCapturedCli({
      cwd: fixture.projectRoot,
      env: {
        AI_QA_AGENTS_HOME: agentsHome,
      },
      readStdin: async () => {
        await writeProjectConfig(fixture.projectRoot, {
          ...config,
          recordingPolicy: { mode: "project-skill" },
        });
        return JSON.stringify(notReady);
      },
    });

    expect(
      await runCli(
        [
          "run",
          "start",
          "--kind",
          "regression",
          "--case",
          "login-success",
          "--platform",
          "web",
          "--execution",
          "ci",
          "--stdin-json",
        ],
        captured.context,
      ),
    ).toBe(0);
    const result = JSON.parse(captured.stdout.join("")) as { runId: string };
    const workOrder = await new RunRepository(
      fixture.projectRoot,
      now,
    ).readVerifiedWorkOrder(result.runId);

    expect(workOrder).toMatchObject({
      kind: "regression",
      execution: "ci",
      preflightResult: true,
      recordingPolicy: { mode: "local-only" },
    });
  });

  it("uses the gated config snapshot for a ready regression CLI run", async () => {
    const fixture = await createActiveCase();
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-replay-agents-"));
    const skillInstall = createCapturedCli({
      env: { AI_QA_AGENTS_HOME: agentsHome },
    });
    expect(
      await runCli(["skill", "install", "--global"], skillInstall.context),
    ).toBe(0);
    const captured = createCapturedCli({
      cwd: fixture.projectRoot,
      env: {
        AI_QA_AGENTS_HOME: agentsHome,
      },
      readStdin: async () => {
        await writeProjectConfig(fixture.projectRoot, {
          ...config,
          recordingPolicy: { mode: "project-skill" },
        });
        return JSON.stringify(ready);
      },
    });

    expect(
      await runCli(
        [
          "run",
          "start",
          "--kind",
          "regression",
          "--case",
          "login-success",
          "--platform",
          "web",
          "--execution",
          "ci",
          "--stdin-json",
        ],
        captured.context,
      ),
    ).toBe(0);
    const workOrder = JSON.parse(captured.stdout.join("")) as unknown;

    expect(workOrder).toMatchObject({
      kind: "regression",
      execution: "ci",
      recordingPolicy: { mode: "local-only" },
    });
  });

  it("rejects finalization when the pinned revision changes on disk", async () => {
    const fixture = await createActiveCase();
    const { workOrder, protocol } = await startFixtureRun(fixture);
    const first = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-1-submit-login",
      criterionId: "home-visible",
      key: "tamper-home",
    });
    const second = await completeStep({
      fixture,
      runId: workOrder.runId,
      protocol,
      stepId: "step-2-account-visible",
      criterionId: "account-visible",
      key: "tamper-account",
    });
    await new VerdictService(
      fixture.projectRoot,
      workOrder.runId,
      now,
    ).set({
      classification: "pass",
      summary: "Replay appears complete",
      criterionResults: [
        {
          criterionId: "home-visible",
          status: "satisfied",
          assertionIds: [first.assertion!.id],
          evidenceIds: [first.evidence.id],
        },
        {
          criterionId: "account-visible",
          status: "satisfied",
          assertionIds: [second.assertion!.id],
          evidenceIds: [second.evidence.id],
        },
      ],
    });
    const revisionPath = join(
      fixture.projectRoot,
      ".ai-qa",
      "cases",
      "login-success",
      "revisions",
      `${String(fixture.revision.revision)}.yaml`,
    );
    const stored = parse(await readFile(revisionPath, "utf8")) as CaseRevision;
    stored.variants.web.steps[1]!.target.description = "Tampered account label";
    await writeFile(revisionPath, stringify(stored, { sortMapEntries: true }));

    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId: workOrder.runId,
        now,
      }),
    ).rejects.toMatchObject({
      code: "case.content_hash_mismatch",
      details: {
        expectedCaseContentHash: workOrder.pinnedCase!.caseContentHash,
        actualCaseContentHash: calculateCaseContentHash(stored),
        expectedPlatformVariantHash: workOrder.pinnedCase!.platformVariantHash,
        actualPlatformVariantHash: calculateWebVariantHash(stored),
      },
    });
  });

  it("keeps regression stdin strict while accepting the exploratory payload shape", async () => {
    const fixture = await createActiveCase();
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-replay-agents-"));
    const captured = createCapturedCli({
      cwd: fixture.projectRoot,
      env: { AI_QA_AGENTS_HOME: agentsHome },
      readStdin: () => Promise.resolve(JSON.stringify(ready)),
    });
    expect(
      await runCli(["skill", "install", "--global"], captured.context),
    ).toBe(0);
    captured.stdout.length = 0;

    expect(
      await runCli(
        [
          "run",
          "start",
          "--kind",
          "regression",
          "--case",
          "login-success",
          "--platform",
          "web",
          "--execution",
          "local",
          "--stdin-json",
        ],
        captured.context,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
      kind: "regression",
      pinnedCase: { caseId: "login-success" },
    });

    captured.stdout.length = 0;
    captured.stderr.length = 0;
    captured.context.readStdin = () =>
      Promise.resolve(JSON.stringify({ ...ready, goal: "not allowed" }));
    expect(
      await runCli(
        [
          "run",
          "start",
          "--kind",
          "regression",
          "--case",
          "login-success",
          "--platform",
          "web",
          "--execution",
          "local",
          "--stdin-json",
        ],
        captured.context,
      ),
    ).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: { code: "input.invalid_json" },
    });

    captured.stderr.length = 0;
    captured.context.readStdin = () =>
      Promise.resolve(
        JSON.stringify({
          goal: "Explore login",
          acceptanceCriteria: [
            {
              id: "login-visible",
              description: "Login is visible",
              requiredEvidence: ["post-action-screenshot"],
            },
          ],
          readiness: ready,
        }),
      );
    expect(
      await runCli(
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
        captured.context,
      ),
    ).toBe(0);
  });
});
