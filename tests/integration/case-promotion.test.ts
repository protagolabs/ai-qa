import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { sha256Canonical } from "../../src/core/canonical-json.js";
import { CaseRepository } from "../../src/core/cases/repository.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { controllerForPlatform } from "../../src/core/platforms/registry.js";
import type { Platform } from "../../src/core/platforms/schema.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";
import {
  activateCaseRevision,
  draftCaseFromRun,
  validateCaseRevision,
} from "../../src/services/case-promotion/draft-case.js";
import { finalizeRun } from "../../src/services/run-protocol/finalize-run.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { VerdictService } from "../../src/services/run-protocol/verdict-service.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import {
  initializeTestProject,
  projectConfig as createProjectConfig,
} from "../helpers/project-fixture.js";

const startedAt = new Date("2026-07-13T00:00:00.000Z");
const runNow = () => new Date("2026-07-13T00:10:00.000Z");
const config: ProjectConfig = createProjectConfig(["web"]);

async function createCompletedPassRun(
  options: {
    extraInteraction?: boolean;
    mislinkedStructuredProof?: boolean;
    appliedUnknown?: boolean;
  } = {},
): Promise<{
  projectRoot: string;
  plannedActionId: string;
  extraActionId?: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-project-"));
  await initializeTestProject({ projectRoot, config });
  const repository = new RunRepository(projectRoot, () => startedAt);
  await repository.create(
    createExploratoryWorkOrder({
      platform: "web",
      projectId: "sample-web",
      runId: "run-source",
      input: exploratoryRunInputSchema.parse({
        goal: "Verify successful login",
        acceptanceCriteria: [
          {
            id: "authenticated-home-visible",
            description: "Authenticated home is visible",
            requiredEvidence:
              options.mislinkedStructuredProof === true
                ? ["structured-text-assertion", "post-action-screenshot"]
                : ["post-action-screenshot"],
          },
        ],
        readiness: { platform: "web", status: "ready", checks: [] },
      }),
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      startedAt,
    }),
  );
  const protocol = new RunProtocolService(projectRoot, "run-source", runNow);
  let unrelatedObservation:
    Awaited<ReturnType<RunProtocolService["addObservation"]>> | undefined;
  let unrelatedEvidence:
    Awaited<ReturnType<typeof registerEvidence>> | undefined;
  if (options.mislinkedStructuredProof === true) {
    const unrelatedObservationAction = await protocol.planAction({
      idempotencyKey: "observe-unrelated-pre-login-state",
      kind: "observation",
      intent: "Observe unrelated state before login",
      tool: "chrome-devtools-mcp",
      target: { description: "Unrelated pre-login state" },
    });
    await protocol.completeAction({
      actionId: unrelatedObservationAction.id,
      phase: "completed",
      toolResult: { summary: "Unrelated state observed" },
    });
    unrelatedObservation = await protocol.addObservation({
      actionId: unrelatedObservationAction.id,
      summary: "Unrelated pre-login state is visible",
      state: { screen: "unrelated" },
    });
    const unrelatedStepId = (
      unrelatedObservationAction.payload as { stepId: string }
    ).stepId;
    const unrelatedCapture = await protocol.planAction({
      idempotencyKey: "capture-unrelated-pre-login-state",
      kind: "evidence-capture",
      intent: "Capture unrelated state before login",
      tool: "chrome-devtools-mcp",
      target: { description: "Unrelated pre-login state" },
      stepId: unrelatedStepId,
    });
    await protocol.completeAction({
      actionId: unrelatedCapture.id,
      phase: "completed",
      toolResult: { summary: "Unrelated screenshot captured" },
    });
    const unrelatedPath = join(projectRoot, "unrelated.png");
    await writeFile(unrelatedPath, Buffer.from([9, 9, 9, 9]));
    unrelatedEvidence = await registerEvidence({
      projectRoot,
      runId: "run-source",
      payload: {
        sourcePath: unrelatedPath,
        mediaType: "image/png",
        sourceTool: "chrome-devtools-mcp",
        sensitivity: "internal",
        evidenceKinds: ["pre-action-screenshot"],
        captureActionId: unrelatedCapture.id,
        idempotencyKey: "unrelated-pre-login-screenshot",
      },
      criterionIds: ["authenticated-home-visible"],
      observationIds: [unrelatedObservation.id],
      now: runNow,
    });
  }
  const planned = await protocol.planAction({
    idempotencyKey: "submit-valid-credentials",
    kind: "interaction",
    intent: "Submit valid credentials",
    tool: "chrome-devtools-mcp",
    target: {
      description: "Login button",
      selector: '[data-testid="login"]',
    },
  });
  const stepId = (planned.payload as { stepId: string }).stepId;
  if (options.appliedUnknown === true) {
    await protocol.completeAction({
      actionId: planned.id,
      phase: "unknown",
      toolResult: { summary: "The login result was ambiguous" },
    });
    const recoveryObservationAction = await protocol.planAction({
      idempotencyKey: "observe-applied-login-recovery",
      kind: "observation",
      intent: "Observe whether the ambiguous login applied",
      tool: "chrome-devtools-mcp",
      target: { description: "Current page" },
      stepId,
    });
    await protocol.completeAction({
      actionId: recoveryObservationAction.id,
      phase: "completed",
      toolResult: { summary: "Observed the ambiguous login result" },
    });
    const recoveryObservation = await protocol.addObservation({
      actionId: recoveryObservationAction.id,
      summary: "Authenticated home confirms the login applied",
      state: { applied: true },
    });
    await protocol.resolveUnknownAction({
      actionId: planned.id,
      resolution: "applied",
      observationId: recoveryObservation.id,
      rationale: "Fresh same-step state confirms the login was applied",
    });
  } else {
    await protocol.completeAction({
      actionId: planned.id,
      phase: "completed",
      toolResult: { summary: "Credentials submitted" },
    });
  }
  const extraAction =
    options.extraInteraction === true
      ? await protocol.planAction({
          idempotencyKey: "open-help-detour",
          kind: "interaction",
          intent: "Open help during exploration",
          tool: "chrome-devtools-mcp",
          target: { description: "Help button" },
        })
      : undefined;
  if (extraAction !== undefined) {
    await protocol.completeAction({
      actionId: extraAction.id,
      phase: "completed",
      toolResult: { summary: "Help opened and exploration continued" },
    });
  }
  const observationAction = await protocol.planAction({
    idempotencyKey: "observe-authenticated-home",
    kind: "observation",
    intent: "Observe authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Current page" },
    stepId,
  });
  await protocol.completeAction({
    actionId: observationAction.id,
    phase: "completed",
    toolResult: { summary: "Authenticated home observed" },
  });
  const observation = await protocol.addObservation({
    actionId: observationAction.id,
    summary: "Authenticated home is visible",
    state: { url: "https://example.com/home" },
  });
  const capture = await protocol.planAction({
    idempotencyKey: "capture-authenticated-home",
    kind: "evidence-capture",
    intent: "Capture authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Authenticated home" },
    stepId,
  });
  await protocol.completeAction({
    actionId: capture.id,
    phase: "completed",
    toolResult: { summary: "Screenshot captured" },
  });
  const sourcePath = join(projectRoot, "home.png");
  await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
  const evidence = await registerEvidence({
    projectRoot,
    runId: "run-source",
    payload: {
      sourcePath,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: capture.id,
      idempotencyKey: "authenticated-home-screenshot",
    },
    criterionIds: ["authenticated-home-visible"],
    observationIds: [observation.id],
    now: runNow,
  });
  const assertion = await protocol.recordAssertion({
    criterionId: "authenticated-home-visible",
    status: "satisfied",
    assertionKinds:
      options.mislinkedStructuredProof === true
        ? ["structured-text-assertion"]
        : ["semantic-ui"],
    actual: "Authenticated home is visible",
    expected: "Authenticated home is visible",
    observationIds: [unrelatedObservation?.id ?? observation.id],
    evidenceIds: [unrelatedEvidence?.id ?? evidence.id],
    stepId,
  });
  const verdict = new VerdictService(projectRoot, "run-source", runNow);
  const verdictEvent = await verdict.set({
    classification: "pass",
    summary: "Login is supported by observation and screenshot evidence",
    criterionResults: [
      {
        criterionId: "authenticated-home-visible",
        status: "satisfied",
        assertionIds: [assertion.id],
        evidenceIds: [evidence.id],
      },
    ],
  });
  if (options.mislinkedStructuredProof === true) {
    await new RunRepository(projectRoot, runNow).journal("run-source").append({
      type: "run",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "finish:run-source",
      payload: { phase: "completed", verdictId: verdictEvent.id },
      relatedIds: [verdictEvent.id],
    });
  } else {
    await finalizeRun({
      projectRoot,
      runId: "run-source",
      now: runNow,
    });
  }
  return {
    projectRoot,
    plannedActionId: planned.id,
    ...(extraAction === undefined ? {} : { extraActionId: extraAction.id }),
  };
}

async function createCompletedUnknownRun(): Promise<{
  projectRoot: string;
  plannedActionId: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-unknown-"));
  const repository = new RunRepository(projectRoot, () => startedAt);
  await repository.create(
    createExploratoryWorkOrder({
      platform: "web",
      projectId: "sample-web",
      runId: "run-unknown",
      input: exploratoryRunInputSchema.parse({
        goal: "Attempt an ambiguous submission",
        acceptanceCriteria: [
          {
            id: "submission-visible",
            description: "Submission is visible",
            requiredEvidence: ["post-action-screenshot"],
          },
        ],
        readiness: { platform: "web", status: "ready", checks: [] },
      }),
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      startedAt,
    }),
  );
  const protocol = new RunProtocolService(projectRoot, "run-unknown", runNow);
  const planned = await protocol.planAction({
    idempotencyKey: "ambiguous-submit",
    kind: "interaction",
    intent: "Submit the form",
    tool: "chrome-devtools-mcp",
    target: { description: "Submit button" },
  });
  await protocol.completeAction({
    actionId: planned.id,
    phase: "unknown",
    toolResult: { summary: "The browser response was ambiguous" },
  });
  const observationAction = await protocol.planAction({
    idempotencyKey: "observe-ambiguous-submit",
    kind: "observation",
    intent: "Observe whether submission applied",
    tool: "chrome-devtools-mcp",
    target: { description: "Current page" },
    stepId: (planned.payload as { stepId: string }).stepId,
  });
  await protocol.completeAction({
    actionId: observationAction.id,
    phase: "completed",
    toolResult: { summary: "Observed current page" },
  });
  const observation = await protocol.addObservation({
    actionId: observationAction.id,
    summary: "Submission state remains ambiguous",
    state: { submitted: "unknown" },
  });
  await protocol.resolveUnknownAction({
    actionId: planned.id,
    resolution: "indeterminate",
    observationId: observation.id,
    rationale: "Fresh observation cannot prove whether submission applied",
  });
  const verdict = new VerdictService(projectRoot, "run-unknown", runNow);
  await verdict.set({
    classification: "not_verified",
    reasonCode: "unknown_action",
    summary: "Submission outcome could not be verified",
    criterionResults: [],
  });
  await finalizeRun({
    projectRoot,
    runId: "run-unknown",
    now: runNow,
  });
  return { projectRoot, plannedActionId: planned.id };
}

async function createStaleCompletedPassRun(): Promise<{
  projectRoot: string;
  plannedActionId: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-stale-"));
  await initializeTestProject({ projectRoot, config });
  const repository = new RunRepository(projectRoot, () => startedAt);
  await repository.create(
    createExploratoryWorkOrder({
      platform: "web",
      projectId: "sample-web",
      runId: "run-source",
      input: exploratoryRunInputSchema.parse({
        goal: "Verify successful login",
        acceptanceCriteria: [
          {
            id: "authenticated-home-visible",
            description: "Authenticated home is visible",
            requiredEvidence: ["post-action-screenshot"],
          },
        ],
        readiness: { platform: "web", status: "ready", checks: [] },
      }),
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      startedAt,
    }),
  );
  const protocol = new RunProtocolService(projectRoot, "run-source", runNow);
  const initialObservationAction = await protocol.planAction({
    idempotencyKey: "observe-initial-login-state",
    kind: "observation",
    intent: "Observe the initial login state",
    tool: "chrome-devtools-mcp",
    target: { description: "Current page" },
  });
  await protocol.completeAction({
    actionId: initialObservationAction.id,
    phase: "completed",
    toolResult: { summary: "Initial login state observed" },
  });
  const initialObservation = await protocol.addObservation({
    actionId: initialObservationAction.id,
    summary: "The login form is visible",
    state: { screen: "login" },
  });
  const initialStepId = (initialObservationAction.payload as { stepId: string })
    .stepId;
  const initialCapture = await protocol.planAction({
    idempotencyKey: "capture-initial-login-state",
    kind: "evidence-capture",
    intent: "Capture the initial login state",
    tool: "chrome-devtools-mcp",
    target: { description: "Login form" },
    stepId: initialStepId,
  });
  await protocol.completeAction({
    actionId: initialCapture.id,
    phase: "completed",
    toolResult: { summary: "Initial login screenshot captured" },
  });
  const sourcePath = join(projectRoot, "stale-login.png");
  await writeFile(sourcePath, Buffer.from([5, 4, 3, 2]));
  const staleEvidence = await registerEvidence({
    projectRoot,
    runId: "run-source",
    payload: {
      sourcePath,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: initialCapture.id,
      idempotencyKey: "stale-login-screenshot",
    },
    criterionIds: ["authenticated-home-visible"],
    observationIds: [initialObservation.id],
    now: runNow,
  });
  const submit = await protocol.planAction({
    idempotencyKey: "submit-after-stale-evidence",
    kind: "interaction",
    intent: "Submit valid credentials",
    tool: "chrome-devtools-mcp",
    target: {
      description: "Login button",
      selector: '[data-testid="login"]',
    },
  });
  await protocol.completeAction({
    actionId: submit.id,
    phase: "completed",
    toolResult: { summary: "Credentials submitted" },
  });
  const submitStepId = (submit.payload as { stepId: string }).stepId;
  const assertion = await protocol.recordAssertion({
    criterionId: "authenticated-home-visible",
    status: "satisfied",
    assertionKinds: ["semantic-ui"],
    actual: "Authenticated home is visible",
    expected: "Authenticated home is visible",
    observationIds: [initialObservation.id],
    evidenceIds: [staleEvidence.id],
    stepId: submitStepId,
  });
  const verdict = await new VerdictService(
    projectRoot,
    "run-source",
    runNow,
  ).set({
    classification: "pass",
    summary: "Pre-action evidence was relabeled as post-action proof",
    criterionResults: [
      {
        criterionId: "authenticated-home-visible",
        status: "satisfied",
        assertionIds: [assertion.id],
        evidenceIds: [staleEvidence.id],
      },
    ],
  });
  await repository.journal("run-source").append({
    type: "run",
    actor: "ai-qa",
    platform: "web",
    tool: "ai-qa",
    idempotencyKey: "finish:run-source",
    payload: { phase: "completed", verdictId: verdict.id },
    relatedIds: [verdict.id],
  });
  return { projectRoot, plannedActionId: submit.id };
}

async function appendDuplicateTypedEvidenceEvent(
  projectRoot: string,
): Promise<void> {
  const eventsPath = join(
    projectRoot,
    ".ai-qa",
    "runs",
    "run-source",
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

async function createCompletedPlatformPassRun(input: {
  projectRoot: string;
  runId: string;
  platform: Platform;
  criterionDescription?: string;
}): Promise<{ plannedActionId: string }> {
  const controller = controllerForPlatform(input.platform);
  const repository = new RunRepository(input.projectRoot, () => startedAt);
  await repository.create(
    createExploratoryWorkOrder({
      platform: input.platform,
      projectId: "sample-web",
      runId: input.runId,
      input: exploratoryRunInputSchema.parse({
        goal: "Verify successful login",
        acceptanceCriteria: [
          {
            id: "authenticated-home-visible",
            description:
              input.criterionDescription ?? "Authenticated home is visible",
            requiredEvidence: ["post-action-screenshot"],
          },
        ],
        readiness: { platform: input.platform, status: "ready", checks: [] },
      }),
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      startedAt,
    }),
  );
  const protocol = new RunProtocolService(
    input.projectRoot,
    input.runId,
    runNow,
  );
  const planned = await protocol.planAction({
    idempotencyKey: `${input.platform}-submit-login`,
    kind: "interaction",
    intent: "Submit valid credentials",
    tool: controller,
    target: { description: "Login button" },
  });
  await protocol.completeAction({
    actionId: planned.id,
    phase: "completed",
    toolResult: { summary: "Credentials submitted" },
  });
  const stepId = (planned.payload as { stepId: string }).stepId;
  const observationAction = await protocol.planAction({
    idempotencyKey: `${input.platform}-observe-home`,
    kind: "observation",
    intent: "Observe authenticated home",
    tool: controller,
    target: { description: "Authenticated home" },
    stepId,
  });
  await protocol.completeAction({
    actionId: observationAction.id,
    phase: "completed",
    toolResult: { summary: "Authenticated home observed" },
  });
  const observation = await protocol.addObservation({
    actionId: observationAction.id,
    summary: "Authenticated home is visible",
    state: { visible: true },
  });
  const capture = await protocol.planAction({
    idempotencyKey: `${input.platform}-capture-home`,
    kind: "evidence-capture",
    intent: "Capture authenticated home",
    tool: controller,
    target: { description: "Authenticated home" },
    stepId,
  });
  await protocol.completeAction({
    actionId: capture.id,
    phase: "completed",
    toolResult: { summary: "Authenticated home captured" },
  });
  const sourcePath = join(
    input.projectRoot,
    `${input.runId}-${input.platform}.png`,
  );
  await writeFile(sourcePath, Buffer.from([1, 2, 3, input.runId.length]));
  const evidence = await registerEvidence({
    projectRoot: input.projectRoot,
    runId: input.runId,
    payload: {
      sourcePath,
      mediaType: "image/png",
      sourceTool: controller,
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: capture.id,
      idempotencyKey: `${input.platform}-home-evidence`,
    },
    criterionIds: ["authenticated-home-visible"],
    observationIds: [observation.id],
    now: runNow,
  });
  const assertion = await protocol.recordAssertion({
    criterionId: "authenticated-home-visible",
    status: "satisfied",
    assertionKinds: ["semantic-ui"],
    actual: "Authenticated home is visible",
    expected: "Authenticated home is visible",
    observationIds: [observation.id],
    evidenceIds: [evidence.id],
    stepId,
  });
  await new VerdictService(input.projectRoot, input.runId, runNow).set({
    classification: "pass",
    summary: "Login is supported by platform evidence",
    criterionResults: [
      {
        criterionId: "authenticated-home-visible",
        status: "satisfied",
        assertionIds: [assertion.id],
        evidenceIds: [evidence.id],
      },
    ],
  });
  await finalizeRun({
    projectRoot: input.projectRoot,
    runId: input.runId,
    now: runNow,
  });
  return { plannedActionId: planned.id };
}

describe("case promotion", () => {
  it("merges and replaces platform variants through new immutable revisions", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-variants-"));
    await initializeTestProject({
      projectRoot,
      config: createProjectConfig(["web", "ios-simulator"]),
    });
    const web = await createCompletedPlatformPassRun({
      projectRoot,
      runId: "run-web-source",
      platform: "web",
    });
    const ios = await createCompletedPlatformPassRun({
      projectRoot,
      runId: "run-ios-source",
      platform: "ios-simulator",
    });
    const webSteps = [
      {
        sourceActionId: web.plannedActionId,
        intent: "Submit valid credentials",
        target: {
          description: "Login button",
          stability: "stable" as const,
          stabilityRationale: "Stable Web control",
        },
        expectedState: "Authenticated home is visible",
        assertionStrategy: "Observe authenticated home",
        evidenceCheckpoints: ["post-action-screenshot"],
      },
    ];
    const iosSteps = [
      {
        sourceActionId: ios.plannedActionId,
        intent: "Submit valid credentials",
        target: {
          description: "Login button",
          stability: "stable" as const,
          stabilityRationale: "Stable accessibility identifier",
        },
        expectedState: "Authenticated home is visible",
        assertionStrategy: "Observe authenticated home",
        evidenceCheckpoints: ["post-action-screenshot"],
      },
    ];
    const webDraft = await draftCaseFromRun({
      projectRoot,
      runId: "run-web-source",
      input: {
        caseId: "login",
        title: "Login",
        steps: webSteps,
        excludedActions: [],
      },
    });
    await activateCaseRevision({
      projectRoot,
      caseId: "login",
      revision: webDraft.revision,
      reviewConfirmed: true,
      now: runNow,
    });
    const iosDraft = await draftCaseFromRun({
      projectRoot,
      runId: "run-ios-source",
      input: {
        caseId: "login",
        title: "Login",
        steps: iosSteps,
        excludedActions: [],
      },
    });

    expect(iosDraft.revision).toBe(webDraft.revision + 1);
    expect(Object.keys(iosDraft.variants).sort()).toEqual([
      "ios-simulator",
      "web",
    ]);
    expect(iosDraft.promotion.sources.web?.sourceRunId).toBe("run-web-source");
    expect(iosDraft.promotion.sources["ios-simulator"]?.sourceRunId).toBe(
      "run-ios-source",
    );
    const indexAfterMerge = parse(
      await readFile(
        join(projectRoot, ".ai-qa", "cases", "login", "case.yaml"),
        "utf8",
      ),
    ) as {
      activeRevision?: number;
      revisions: Array<{
        revision: number;
        status: string;
        activation?: unknown;
      }>;
    };
    expect(indexAfterMerge.activeRevision).toBe(webDraft.revision);
    expect(indexAfterMerge.revisions[0]).toMatchObject({
      revision: webDraft.revision,
      status: "active",
      activation: { confirmedBy: "user" },
    });

    const webReplacement = await createCompletedPlatformPassRun({
      projectRoot,
      runId: "run-web-replacement",
      platform: "web",
    });
    const replacement = await draftCaseFromRun({
      projectRoot,
      runId: "run-web-replacement",
      input: {
        caseId: "login",
        title: "Login",
        steps: [
          {
            ...webSteps[0]!,
            sourceActionId: webReplacement.plannedActionId,
            expectedState: "Authenticated dashboard is visible",
          },
        ],
        excludedActions: [],
      },
    });
    expect(replacement.revision).toBe(iosDraft.revision + 1);
    expect(replacement.promotion.sources.web?.sourceRunId).toBe(
      "run-web-replacement",
    );
    expect(replacement.promotion.sources["ios-simulator"]?.sourceRunId).toBe(
      "run-ios-source",
    );
    expect(replacement.variants.web?.steps[0]?.expectedState).toBe(
      "Authenticated dashboard is visible",
    );
    expect(replacement.variants["ios-simulator"]).toEqual(
      iosDraft.variants["ios-simulator"],
    );
    await expect(
      new CaseRepository(projectRoot, runNow).readRevision(
        "login",
        iosDraft.revision,
      ),
    ).resolves.toEqual(iosDraft);
  });

  it("keeps criteria mismatch as a stable activation-blocking issue", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-mismatch-"));
    await initializeTestProject({
      projectRoot,
      config: createProjectConfig(["web", "ios-simulator"]),
    });
    const web = await createCompletedPlatformPassRun({
      projectRoot,
      runId: "run-web-source",
      platform: "web",
    });
    const ios = await createCompletedPlatformPassRun({
      projectRoot,
      runId: "run-ios-source",
      platform: "ios-simulator",
      criterionDescription: "Authenticated dashboard is visible",
    });
    const step = (sourceActionId: string) => ({
      sourceActionId,
      intent: "Submit valid credentials",
      target: {
        description: "Login button",
        stability: "stable" as const,
        stabilityRationale: "Stable platform control",
      },
      expectedState: "Authenticated home is visible",
      assertionStrategy: "Observe authenticated home",
      evidenceCheckpoints: ["post-action-screenshot"],
    });
    await draftCaseFromRun({
      projectRoot,
      runId: "run-web-source",
      input: {
        caseId: "login-mismatch",
        title: "Login",
        steps: [step(web.plannedActionId)],
        excludedActions: [],
      },
    });
    const mismatch = await draftCaseFromRun({
      projectRoot,
      runId: "run-ios-source",
      input: {
        caseId: "login-mismatch",
        title: "Login",
        steps: [step(ios.plannedActionId)],
        excludedActions: [],
      },
    });

    expect(mismatch.promotion.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "case.acceptance_criteria_mismatch" }),
      ]),
    );
    await expect(
      activateCaseRevision({
        projectRoot,
        caseId: mismatch.caseId,
        revision: mismatch.revision,
        reviewConfirmed: true,
        now: runNow,
      }),
    ).rejects.toMatchObject({ code: "case.activation_validation_failed" });
  });

  it("keeps a completed history with pre-action evidence inactive", async () => {
    const { projectRoot, plannedActionId } =
      await createStaleCompletedPassRun();
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "stale-login-proof",
        title: "Reject stale login proof",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              selector: '[data-testid="login"]',
              stability: "stable",
              stabilityRationale: "Unique application-owned data-testid",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "Observe the authenticated shell",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [],
      },
    });

    expect(draft.promotion.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "case.evidence_invalid" }),
      ]),
    );
  });

  it("validates case storage before acquiring activation locks", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-case-outside-"));
    const casesRoot = join(projectRoot, ".ai-qa", "cases");
    await mkdir(casesRoot, { recursive: true });
    await symlink(outside, join(casesRoot, "symlinked-activation"));
    await chmod(outside, 0o500);

    try {
      await expect(
        new CaseRepository(projectRoot, runNow).activate(
          "symlinked-activation",
          1,
          {
            confirmedBy: "user",
            confirmedAt: "2026-07-13T00:10:00.000Z",
          },
        ),
      ).rejects.toMatchObject({ code: "storage.integrity_error" });
      await expect(
        access(join(outside, "case.yaml.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(outside, 0o700);
    }
  });

  it("preserves case.not_found for a genuinely missing case", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-missing-"));
    await mkdir(join(projectRoot, ".ai-qa", "cases"), { recursive: true });

    await expect(
      new CaseRepository(projectRoot, runNow).readActive("missing-case"),
    ).rejects.toMatchObject({ code: "case.not_found" });
  });

  it("preserves case.revision_not_found for a genuinely missing revision", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-revision-missing-"),
    );
    await mkdir(
      join(projectRoot, ".ai-qa", "cases", "missing-revision", "revisions"),
      { recursive: true },
    );

    await expect(
      new CaseRepository(projectRoot, runNow).readRevision(
        "missing-revision",
        1,
      ),
    ).rejects.toMatchObject({ code: "case.revision_not_found" });
  });

  it("preserves storage integrity errors for a symlinked case index", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-case-outside-"));
    const caseDirectory = join(
      projectRoot,
      ".ai-qa",
      "cases",
      "symlinked-index",
    );
    await mkdir(caseDirectory, { recursive: true });
    const outsideIndex = join(outside, "case.yaml");
    await writeFile(outsideIndex, "schemaVersion: 1\n");
    await symlink(outsideIndex, join(caseDirectory, "case.yaml"));

    await expect(
      new CaseRepository(projectRoot, runNow).readActive("symlinked-index"),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
  });

  it("preserves storage integrity errors when validating a symlinked revision", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-case-outside-"));
    const revisions = join(
      projectRoot,
      ".ai-qa",
      "cases",
      "symlinked-revision",
      "revisions",
    );
    await mkdir(revisions, { recursive: true });
    const outsideRevision = join(outside, "1.yaml");
    await writeFile(outsideRevision, "schemaVersion: 1\n");
    await symlink(outsideRevision, join(revisions, "1.yaml"));

    await expect(
      new CaseRepository(projectRoot, runNow).validateRevision(
        "symlinked-revision",
        1,
      ),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
  });

  it("rejects a symlinked cases root before creating a draft outside the project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-cases-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-cases-outside-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    await symlink(outside, join(projectRoot, ".ai-qa", "cases"));

    await expect(
      new CaseRepository(projectRoot, runNow).createDraft({
        schemaVersion: 1,
        caseId: "login-success",
        title: "Login succeeds",
        promotion: {
          sources: {
            web: { sourceRunId: "run-source", excludedActions: [] },
          },
          validationIssues: [],
        },
        acceptanceCriteria: [
          {
            id: "authenticated-home-visible",
            description: "Authenticated home is visible",
            requiredEvidence: ["post-action-screenshot"],
          },
        ],
        variants: {
          web: {
            steps: [
              {
                id: "step-submit-login",
                sourceActionId: "event-submit-login",
                intent: "Submit valid credentials",
                tool: "chrome-devtools-mcp",
                target: {
                  description: "Login button",
                  stability: "stable",
                  stabilityRationale: "Stable test id",
                },
                expectedState: "Authenticated home is visible",
                assertionStrategy: "Observe authenticated shell",
                evidenceCheckpoints: ["post-action-screenshot"],
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
    await expect(access(join(outside, "login-success"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes concurrent creators through first-index bootstrap", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-concurrent-"));
    const repository = new CaseRepository(projectRoot, runNow);
    const input = {
      schemaVersion: 1 as const,
      caseId: "concurrent-case",
      title: "Concurrent case",
      promotion: {
        sources: { web: { sourceRunId: "run-source" } },
        validationIssues: [],
      },
      acceptanceCriteria: [
        {
          id: "home-visible",
          description: "Home is visible",
          requiredEvidence: ["post-action-screenshot"],
        },
      ],
      variants: {
        web: {
          steps: [
            {
              id: "step-1-submit-login",
              sourceActionId: "event-submit-login",
              intent: "Submit login",
              tool: "chrome-devtools-mcp" as const,
              target: {
                description: "Login button",
                stability: "stable" as const,
                stabilityRationale: "Unique application-owned control",
              },
              expectedState: "Home is visible",
              assertionStrategy: "Visible home",
              evidenceCheckpoints: ["post-action-screenshot"],
            },
          ],
        },
      },
    };

    const revisions = await Promise.all(
      Array.from({ length: 8 }, () => repository.createDraft(input)),
    );

    expect(
      revisions.map((revision) => revision.revision).sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("removes only its owned partial index after bootstrap failure", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-bootstrap-"));
    const probe = await open(join(projectRoot, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as {
      sync: () => Promise<void>;
    };
    await probe.close();
    const sync = vi
      .spyOn(prototype, "sync")
      .mockRejectedValueOnce(new Error("simulated index sync failure"));
    const repository = new CaseRepository(projectRoot, runNow);
    const input = {
      schemaVersion: 1 as const,
      caseId: "bootstrap-cleanup",
      title: "Bootstrap cleanup",
      promotion: {
        sources: { web: { sourceRunId: "run-source" } },
        validationIssues: [],
      },
      acceptanceCriteria: [
        {
          id: "home-visible",
          description: "Home is visible",
          requiredEvidence: ["post-action-screenshot"],
        },
      ],
      variants: {
        web: {
          steps: [
            {
              id: "step-1-submit-login",
              sourceActionId: "event-submit-login",
              intent: "Submit login",
              tool: "chrome-devtools-mcp" as const,
              target: {
                description: "Login button",
                stability: "stable" as const,
                stabilityRationale: "Unique application-owned control",
              },
              expectedState: "Home is visible",
              assertionStrategy: "Visible home",
              evidenceCheckpoints: ["post-action-screenshot"],
            },
          ],
        },
      },
    };
    const indexPath = join(
      projectRoot,
      ".ai-qa",
      "cases",
      input.caseId,
      "case.yaml",
    );

    await expect(repository.createDraft(input)).rejects.toThrow(
      "simulated index sync failure",
    );
    sync.mockRestore();
    await expect(readFile(indexPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(repository.createDraft(input)).resolves.toMatchObject({
      revision: 1,
    });
  });

  it("never deletes a pre-existing immutable revision after a create collision", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-collision-"));
    const revisionPath = join(
      projectRoot,
      ".ai-qa",
      "cases",
      "collision-case",
      "revisions",
      "1.yaml",
    );
    await mkdir(join(revisionPath, ".."), { recursive: true });
    await writeFile(revisionPath, "pre-existing-revision");
    const repository = new CaseRepository(projectRoot, runNow);

    await expect(
      repository.createDraft({
        schemaVersion: 1,
        caseId: "collision-case",
        title: "Collision case",
        promotion: {
          sources: { web: { sourceRunId: "run-source" } },
          validationIssues: [],
        },
        acceptanceCriteria: [
          {
            id: "home-visible",
            description: "Home is visible",
            requiredEvidence: ["post-action-screenshot"],
          },
        ],
        variants: {
          web: {
            steps: [
              {
                id: "step-1-submit-login",
                sourceActionId: "event-submit-login",
                intent: "Submit login",
                tool: "chrome-devtools-mcp",
                target: {
                  description: "Login button",
                  stability: "stable",
                  stabilityRationale: "Unique application-owned control",
                },
                expectedState: "Home is visible",
                assertionStrategy: "Visible home",
                evidenceCheckpoints: ["post-action-screenshot"],
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "case.revision_already_exists" });
    await expect(readFile(revisionPath, "utf8")).resolves.toBe(
      "pre-existing-revision",
    );
  });

  it("activates a reviewed evidence-backed draft without rewriting the revision", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun();
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "login-success",
        title: "Successful login",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              selector: '[data-testid="login"]',
              stability: "stable",
              stabilityRationale: "Unique data-testid owned by the application",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "URL and visible account text",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [],
      },
    });

    expect(draft).toMatchObject({
      caseId: "login-success",
      revision: 1,
      promotion: {
        sources: { web: { sourceRunId: "run-source" } },
        validationIssues: [],
      },
      variants: {
        web: {
          steps: [
            {
              id: "step-1-submit-valid-credentials",
              sourceActionId: plannedActionId,
              tool: "chrome-devtools-mcp",
            },
          ],
        },
      },
    });
    await expect(
      validateCaseRevision({
        projectRoot,
        caseId: "login-success",
        revision: 1,
      }),
    ).resolves.toMatchObject({ valid: true, issues: [] });

    const revisionPath = join(
      projectRoot,
      ".ai-qa",
      "cases",
      "login-success",
      "revisions",
      "1.yaml",
    );
    const beforeActivation = await readFile(revisionPath, "utf8");
    await activateCaseRevision({
      projectRoot,
      caseId: "login-success",
      revision: 1,
      reviewConfirmed: true,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(await readFile(revisionPath, "utf8")).toBe(beforeActivation);
    await mkdir(join(projectRoot, ".ai-qa", "cases"), { recursive: true });
    await expect(writeFile(revisionPath, "changed")).resolves.toBeUndefined();
    await expect(
      validateCaseRevision({
        projectRoot,
        caseId: "login-success",
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: "case.content_hash_mismatch" });
  });

  it("activates a pass whose interaction is confirmed by an applied recovery", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun({
      appliedUnknown: true,
    });
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "applied-unknown-login",
        title: "Applied unknown login",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              selector: '[data-testid="login"]',
              stability: "stable",
              stabilityRationale: "Unique application-owned data-testid",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "URL and visible account text",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [],
      },
    });

    expect(draft.promotion.validationIssues).toEqual([]);
    await expect(
      validateCaseRevision({
        projectRoot,
        caseId: draft.caseId,
        revision: draft.revision,
      }),
    ).resolves.toMatchObject({ valid: true, issues: [] });
    await expect(
      activateCaseRevision({
        projectRoot,
        caseId: draft.caseId,
        revision: draft.revision,
        reviewConfirmed: true,
        now: runNow,
      }),
    ).resolves.toMatchObject({
      caseId: draft.caseId,
      revision: draft.revision,
    });
  });

  it("keeps a duplicate-index source as an inactive draft", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun();
    const indexPath = join(
      projectRoot,
      ".ai-qa",
      "evidence",
      "run-source",
      "index.jsonl",
    );
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, `${index}${index}`);
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "duplicate-source-evidence",
        title: "Duplicate source evidence",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              stability: "stable",
              stabilityRationale: "Unique application-owned control",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "Visible account text",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [],
      },
    });

    expect(draft.promotion.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "case.evidence_invalid" }),
      ]),
    );
    await expect(
      activateCaseRevision({
        projectRoot,
        caseId: draft.caseId,
        revision: draft.revision,
        reviewConfirmed: true,
        now: runNow,
      }),
    ).rejects.toMatchObject({ code: "case.activation_validation_failed" });
  });

  it("keeps duplicate typed evidence as an inactive draft", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun();
    await appendDuplicateTypedEvidenceEvent(projectRoot);

    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "duplicate-typed-source-evidence",
        title: "Duplicate typed source evidence",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              stability: "stable",
              stabilityRationale: "Unique application-owned control",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "Visible account text",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [],
      },
    });

    expect(draft.promotion.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "case.evidence_invalid" }),
      ]),
    );
    await expect(
      activateCaseRevision({
        projectRoot,
        caseId: draft.caseId,
        revision: draft.revision,
        reviewConfirmed: true,
        now: runNow,
      }),
    ).rejects.toMatchObject({ code: "case.activation_validation_failed" });
  });

  it("does not let invalid evidence hide unrelated protocol corruption", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun();
    await appendDuplicateTypedEvidenceEvent(projectRoot);
    const eventsPath = join(
      projectRoot,
      ".ai-qa",
      "runs",
      "run-source",
      "events.jsonl",
    );
    const events = (await readFile(eventsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const observation = events.find((event) => event.type === "observation");
    if (observation === undefined) throw new Error("missing observation event");
    observation.actor = "ai-qa";
    await writeFile(
      eventsPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await expect(
      draftCaseFromRun({
        projectRoot,
        runId: "run-source",
        input: {
          caseId: "corrupt-protocol-with-invalid-evidence",
          title: "Corrupt protocol with invalid evidence",
          steps: [
            {
              sourceActionId: plannedActionId,
              intent: "Submit valid credentials",
              target: {
                description: "Login button",
                stability: "stable",
                stabilityRationale: "Unique application-owned control",
              },
              expectedState: "Authenticated home is visible",
              assertionStrategy: "Visible account text",
              evidenceCheckpoints: ["post-action-screenshot"],
            },
          ],
          excludedActions: [],
        },
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
  });

  it("rejects a forged controller before emitting a case step", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun();
    const journal = new RunRepository(projectRoot, runNow).journal(
      "run-source",
    );
    const forged = await journal.append({
      type: "action",
      actor: "agent",
      platform: "web",
      tool: "fake-browser",
      idempotencyKey: "forged-controller-action",
      payload: {
        phase: "planned",
        kind: "interaction",
        intent: "Submit valid credentials with a forged controller",
        stepId: "step-forged-controller",
        target: { description: "Login button" },
      },
      relatedIds: [],
    });
    await journal.append({
      type: "action",
      actor: "agent",
      platform: "web",
      tool: "fake-browser",
      idempotencyKey: `complete:${forged.id}`,
      payload: {
        phase: "completed",
        actionId: forged.id,
        toolResult: { summary: "Credentials submitted" },
      },
      relatedIds: [forged.id],
    });

    await expect(
      draftCaseFromRun({
        projectRoot,
        runId: "run-source",
        input: {
          caseId: "forged-controller",
          title: "Forged controller",
          steps: [
            {
              sourceActionId: forged.id,
              intent: "Submit valid credentials",
              target: {
                description: "Login button",
                stability: "stable",
                stabilityRationale: "Unique application-owned control",
              },
              expectedState: "Authenticated home is visible",
              assertionStrategy: "Visible account text",
              evidenceCheckpoints: ["post-action-screenshot"],
            },
          ],
          excludedActions: [
            {
              actionId: plannedActionId,
              reason: "Replaced by the forged controller test action",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
  });

  it("rejects an assertion checkpoint that cites proof from before another step", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun({
      mislinkedStructuredProof: true,
    });
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "mislinked-structured-proof",
        title: "Mislinked structured proof",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              selector: '[data-testid="login"]',
              stability: "stable",
              stabilityRationale: "Unique application-owned data-testid",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "Read the authenticated account text",
            evidenceCheckpoints: [
              "structured-text-assertion",
              "post-action-screenshot",
            ],
          },
        ],
        excludedActions: [],
      },
    });

    expect(draft.promotion.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "case.evidence_checkpoint_missing",
          relatedIds: [plannedActionId, "structured-text-assertion"],
        }),
      ]),
    );
  });

  it("rejects a completed pass whose criterion result lacks assertion support", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun();
    const eventsPath = join(
      projectRoot,
      ".ai-qa",
      "runs",
      "run-source",
      "events.jsonl",
    );
    const events = (await readFile(eventsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            payload: unknown;
            idempotencyKey?: string;
            relatedIds: string[];
          },
      );
    const verdict = events.find((event) => event.type === "verdict")!;
    const payload = verdict.payload as {
      criterionResults: Array<{
        assertionIds: string[];
        evidenceIds: string[];
      }>;
    };
    payload.criterionResults[0]!.assertionIds = [];
    verdict.idempotencyKey = `verdict:${sha256Canonical(payload)}`;
    verdict.relatedIds = payload.criterionResults.flatMap(
      (result) => result.evidenceIds,
    );
    await writeFile(
      eventsPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "unsupported-pass",
        title: "Unsupported pass",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              stability: "stable",
              stabilityRationale: "Unique application-owned control",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "Visible account text",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [],
      },
    });

    expect(
      draft.promotion.validationIssues.map((entry) => entry.code),
    ).toContain("case.criterion_coverage_missing");
    await expect(
      activateCaseRevision({
        projectRoot,
        caseId: draft.caseId,
        revision: draft.revision,
        reviewConfirmed: true,
        now: runNow,
      }),
    ).rejects.toMatchObject({ code: "case.activation_validation_failed" });
  });

  it("hash-binds excluded interaction IDs and their review rationales", async () => {
    const { projectRoot, plannedActionId, extraActionId } =
      await createCompletedPassRun({ extraInteraction: true });
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "audited-detour",
        title: "Audited exploratory detour",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              stability: "stable",
              stabilityRationale: "Unique application-owned control",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "Visible account text",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [
          {
            actionId: extraActionId!,
            reason: "Exploratory help detour is not part of login regression",
          },
        ],
      },
    });

    expect(draft.promotion.sources.web?.excludedActions).toEqual([
      {
        actionId: extraActionId,
        reason: "Exploratory help detour is not part of login regression",
      },
    ]);
    await expect(
      validateCaseRevision({
        projectRoot,
        caseId: draft.caseId,
        revision: draft.revision,
      }),
    ).resolves.toMatchObject({ valid: true, issues: [] });
  });

  it("does not trust caller-supplied empty issues to bypass interaction accounting", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun({
      extraInteraction: true,
    });
    const revision = await new CaseRepository(projectRoot, runNow).createDraft({
      schemaVersion: 1,
      caseId: "forged-accounting",
      title: "Forged accounting",
      promotion: {
        sources: { web: { sourceRunId: "run-source" } },
        validationIssues: [],
      },
      acceptanceCriteria: [
        {
          id: "authenticated-home-visible",
          description: "Authenticated home is visible",
          requiredEvidence: ["post-action-screenshot"],
        },
      ],
      variants: {
        web: {
          steps: [
            {
              id: "step-1-submit-valid-credentials",
              sourceActionId: plannedActionId,
              intent: "Submit valid credentials",
              tool: "chrome-devtools-mcp",
              target: {
                description: "Login button",
                stability: "stable",
                stabilityRationale: "Unique application-owned control",
              },
              expectedState: "Authenticated home is visible",
              assertionStrategy: "Visible account text",
              evidenceCheckpoints: ["post-action-screenshot"],
            },
          ],
        },
      },
    });

    await expect(
      activateCaseRevision({
        projectRoot,
        caseId: revision.caseId,
        revision: revision.revision,
        reviewConfirmed: true,
        now: runNow,
      }),
    ).rejects.toMatchObject({ code: "case.activation_validation_failed" });
  });

  it("keeps unknown or indeterminate exploratory material as an inactive draft", async () => {
    const { projectRoot, plannedActionId } = await createCompletedUnknownRun();
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-unknown",
      input: {
        caseId: "ambiguous-submit",
        title: "Ambiguous submission",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit the form",
            target: {
              description: "Submit button",
              stability: "stable",
              stabilityRationale: "Unique submit control",
            },
            expectedState: "Submission is visible",
            assertionStrategy: "Visible confirmation text",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [],
      },
    });

    expect(draft.promotion.validationIssues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "case.source_verdict_not_pass",
        "case.unknown_action_unresolved",
        "case.evidence_checkpoint_missing",
      ]),
    );
    await expect(
      activateCaseRevision({
        projectRoot,
        caseId: draft.caseId,
        revision: draft.revision,
        reviewConfirmed: true,
        now: runNow,
      }),
    ).rejects.toMatchObject({ code: "case.activation_validation_failed" });
  });

  it("rejects tampered active index hashes and missing activation provenance", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun();
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "index-integrity",
        title: "Index integrity",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              stability: "stable",
              stabilityRationale: "Unique application-owned control",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "Visible account text",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [],
      },
    });
    await activateCaseRevision({
      projectRoot,
      caseId: draft.caseId,
      revision: draft.revision,
      reviewConfirmed: true,
      now: runNow,
    });
    const repository = new CaseRepository(projectRoot, runNow);
    const indexPath = join(
      projectRoot,
      ".ai-qa",
      "cases",
      draft.caseId,
      "case.yaml",
    );
    const original = parse(await readFile(indexPath, "utf8")) as {
      revisions: Array<{
        contentHash: string;
        activation?: { confirmedBy: string; confirmedAt: string };
      }>;
    };
    const hashTampered = structuredClone(original);
    hashTampered.revisions[0]!.contentHash = "sha256:tampered";
    await writeFile(indexPath, stringify(hashTampered));
    await expect(repository.readActive(draft.caseId)).rejects.toMatchObject({
      code: "case.index_integrity_error",
    });

    const provenanceTampered = structuredClone(original);
    delete provenanceTampered.revisions[0]!.activation;
    await writeFile(indexPath, stringify(provenanceTampered));
    await expect(repository.readActive(draft.caseId)).rejects.toMatchObject({
      code: "case.index_integrity_error",
    });
  });

  it("cross-checks draft revision hashes against the case index", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun();
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "draft-index-integrity",
        title: "Draft index integrity",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              stability: "stable",
              stabilityRationale: "Unique application-owned control",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "Visible account text",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [],
      },
    });
    const indexPath = join(
      projectRoot,
      ".ai-qa",
      "cases",
      draft.caseId,
      "case.yaml",
    );
    const index = parse(await readFile(indexPath, "utf8")) as {
      revisions: Array<{ contentHash: string }>;
    };
    index.revisions[0]!.contentHash = "sha256:tampered";
    await writeFile(indexPath, stringify(index));

    await expect(
      validateCaseRevision({
        projectRoot,
        caseId: draft.caseId,
        revision: draft.revision,
      }),
    ).rejects.toMatchObject({ code: "case.index_integrity_error" });
  });

  it("requires exact activation confirmation through the public case command", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun();
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "cli-activation",
        title: "CLI activation",
        steps: [
          {
            sourceActionId: plannedActionId,
            intent: "Submit valid credentials",
            target: {
              description: "Login button",
              stability: "stable",
              stabilityRationale: "Unique application-owned control",
            },
            expectedState: "Authenticated home is visible",
            assertionStrategy: "Visible account text",
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
        excludedActions: [],
      },
    });
    const rejected = createCapturedCli({
      cwd: projectRoot,
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({ reviewConfirmed: true, unexpected: true }),
        ),
    });
    expect(
      await runCli(
        [
          "case",
          "activate",
          draft.caseId,
          "--revision",
          String(draft.revision),
          "--stdin-json",
        ],
        rejected.context,
      ),
    ).toBe(1);
    expect(rejected.stderr.join("")).toContain("input.invalid_json");

    const confirmed = createCapturedCli({
      cwd: projectRoot,
      readStdin: () => Promise.resolve('{"reviewConfirmed":true}'),
    });
    expect(
      await runCli(
        [
          "case",
          "activate",
          draft.caseId,
          "--revision",
          String(draft.revision),
          "--stdin-json",
        ],
        confirmed.context,
      ),
    ).toBe(0);
    const activationOutput = JSON.parse(confirmed.stdout.join("")) as {
      caseId: string;
      activeRevision: number;
      contentHash: string;
      activation: { confirmedBy: string; confirmedAt: string };
    };
    expect(activationOutput).toMatchObject({
      caseId: draft.caseId,
      activeRevision: draft.revision,
      contentHash: draft.contentHash,
      activation: { confirmedBy: "user" },
    });
    const retried = createCapturedCli({
      cwd: projectRoot,
      now: () => new Date("2026-07-13T00:20:00.000Z"),
      readStdin: () => Promise.resolve('{"reviewConfirmed":true}'),
    });
    expect(
      await runCli(
        [
          "case",
          "activate",
          draft.caseId,
          "--revision",
          String(draft.revision),
          "--stdin-json",
        ],
        retried.context,
      ),
    ).toBe(0);
    const retryOutput = JSON.parse(retried.stdout.join("")) as {
      activation: { confirmedBy: string; confirmedAt: string };
    };
    const index = parse(
      await readFile(
        join(projectRoot, ".ai-qa", "cases", draft.caseId, "case.yaml"),
        "utf8",
      ),
    ) as {
      revisions: Array<{
        activation?: { confirmedBy: string; confirmedAt: string };
      }>;
    };
    expect(retryOutput.activation.confirmedAt).toBe("2026-07-13T00:20:00.000Z");
    expect(index.revisions[0]!.activation).toEqual(activationOutput.activation);
  });

  it("drafts and validates immutable revisions through the public case command", async () => {
    const { projectRoot, plannedActionId } = await createCompletedPassRun();
    const drafted = createCapturedCli({
      cwd: projectRoot,
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            caseId: "cli-draft",
            title: "CLI draft",
            steps: [
              {
                sourceActionId: plannedActionId,
                intent: "Submit valid credentials",
                target: {
                  description: "Login button",
                  stability: "stable",
                  stabilityRationale: "Unique application-owned control",
                },
                expectedState: "Authenticated home is visible",
                assertionStrategy: "Visible account text",
                evidenceCheckpoints: ["post-action-screenshot"],
              },
            ],
            excludedActions: [],
          }),
        ),
    });
    expect(
      await runCli(
        ["case", "draft", "--from-run", "run-source", "--stdin-json"],
        drafted.context,
      ),
    ).toBe(0);
    const revision = JSON.parse(drafted.stdout.join("")) as {
      caseId: string;
      revision: number;
    };

    const validated = createCapturedCli({
      cwd: projectRoot,
    });
    expect(
      await runCli(
        [
          "case",
          "validate",
          revision.caseId,
          "--revision",
          String(revision.revision),
        ],
        validated.context,
      ),
    ).toBe(0);
    expect(JSON.parse(validated.stdout.join(""))).toMatchObject({
      valid: true,
      issues: [],
      revision: { caseId: revision.caseId, revision: revision.revision },
    });
  });
});
