import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram, runCli } from "../../src/cli/program.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import { resolveRunPaths } from "../../src/core/runs/paths.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  workOrderSchema,
} from "../../src/core/runs/schema.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { createCapturedCli } from "../helpers/cli-context.js";

const fixedNow = () => new Date("2026-07-13T00:00:00.000Z");

interface MutableClock {
  current: Date;
}

async function createTrustedRun(): Promise<{
  projectRoot: string;
  aiQaHome: string;
  repository: RunRepository;
  service: RunProtocolService;
  clock: MutableClock;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-protocol-project-"));
  const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-protocol-home-"));
  const clock = { current: fixedNow() };
  const now = () => new Date(clock.current);
  await confirmProjectTrust({
    projectRoot,
    aiQaHome,
    confirmed: true,
    now: fixedNow(),
  });
  const repository = new RunRepository(projectRoot, now);
  await repository.create(
    createExploratoryWorkOrder({
      projectId: "sample-web",
      runId: "run-1",
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
      startedAt: fixedNow(),
    }),
  );
  return {
    projectRoot,
    aiQaHome,
    service: new RunProtocolService(projectRoot, aiQaHome, "run-1", now),
    repository,
    clock,
  };
}

async function createSmallBudgetRun(input: {
  maxToolCalls: number;
  maxRecoveryActions: number;
}): Promise<Awaited<ReturnType<typeof createTrustedRun>>> {
  const existing = createExploratoryWorkOrder({
    projectId: "sample-web",
    runId: "run-1",
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
    startedAt: fixedNow(),
  });
  const replacement = workOrderSchema.parse({
    ...existing,
    kind: "regression",
    budget: {
      ...input,
      deadline: "2026-07-13T00:10:00.000Z",
    },
    pinnedCase: {
      caseId: "case-login",
      revision: 1,
      caseContentHash: `sha256:${"a".repeat(64)}`,
      platformVariantHash: `sha256:${"b".repeat(64)}`,
    },
  });
  const replacementRoot = await mkdtemp(
    join(tmpdir(), "ai-qa-protocol-budget-project-"),
  );
  const replacementHome = await mkdtemp(
    join(tmpdir(), "ai-qa-protocol-budget-home-"),
  );
  await confirmProjectTrust({
    projectRoot: replacementRoot,
    aiQaHome: replacementHome,
    confirmed: true,
    now: fixedNow(),
  });
  const clock = { current: fixedNow() };
  const now = () => new Date(clock.current);
  const repository = new RunRepository(replacementRoot, now);
  await repository.create(replacement);
  return {
    projectRoot: replacementRoot,
    aiQaHome: replacementHome,
    repository,
    clock,
    service: new RunProtocolService(
      replacementRoot,
      replacementHome,
      "run-1",
      now,
    ),
  };
}

async function addCurrentObservation(
  service: RunProtocolService,
  key: string,
): Promise<{ actionId: string; eventId: string; stepId: string }> {
  const action = await service.planAction({
    idempotencyKey: key,
    kind: "observation",
    intent: "Inspect current UI",
    tool: "chrome-devtools-mcp",
    target: { description: "Current browser page" },
  });
  await service.completeAction({
    actionId: action.id,
    phase: "completed",
    toolResult: { summary: "Current page captured" },
  });
  const event = await service.addObservation({
    actionId: action.id,
    summary: "Authenticated home is visible",
    state: { url: "https://example.com/home" },
  });
  const payload = action.payload as { stepId: string };
  return { actionId: action.id, eventId: event.id, stepId: payload.stepId };
}

describe("typed run protocol", () => {
  it("plans an action and requires a fresh observation to resolve an unknown result", async () => {
    const { service } = await createTrustedRun();
    const planned = await service.planAction({
      idempotencyKey: "click-login",
      kind: "interaction",
      intent: "Submit valid credentials",
      tool: "chrome-devtools-mcp",
      target: {
        description: "Login submit button",
        selector: '[data-testid="login"]',
      },
    });
    expect(planned.payload).toMatchObject({ phase: "planned" });
    expect((planned.payload as { stepId: string }).stepId).toMatch(/^step-/);

    await service.completeAction({
      actionId: planned.id,
      phase: "unknown",
      toolResult: { summary: "MCP connection closed before response" },
    });

    await expect(
      service.resolveUnknownAction({
        actionId: planned.id,
        resolution: "not_applied",
        observationId: "event-missing-observation",
        rationale: "No transition occurred",
      }),
    ).rejects.toMatchObject({
      code: "recovery.fresh_observation_required",
    });

    const observationAction = await service.planAction({
      idempotencyKey: "observe-after-unknown",
      kind: "observation",
      intent: "Inspect whether login was submitted",
      tool: "chrome-devtools-mcp",
      target: { description: "Current browser page" },
    });
    await service.completeAction({
      actionId: observationAction.id,
      phase: "completed",
      toolResult: { summary: "Current page captured" },
    });
    const observation = await service.addObservation({
      actionId: observationAction.id,
      summary: "Login form remains visible",
      state: { url: "https://example.com/login" },
    });

    const recovery = await service.resolveUnknownAction({
      actionId: planned.id,
      resolution: "not_applied",
      observationId: observation.id,
      rationale: "The form remains on the login page",
    });
    expect(recovery).toMatchObject({
      type: "recovery",
      payload: { resolution: "not_applied" },
    });
    await expect(
      service.planAction({
        idempotencyKey: "retry-login",
        kind: "interaction",
        intent: "Retry login after proving it was not applied",
        tool: "chrome-devtools-mcp",
        target: { description: "Login submit button" },
        recoveryForStepId: (planned.payload as { stepId: string }).stepId,
      }),
    ).resolves.toMatchObject({ type: "action" });
  });

  it("makes action planning and completion idempotent and rejects conflicts", async () => {
    const { service } = await createTrustedRun();
    const reserved = await service.recordDecision({
      kind: "semantic",
      rationale: "Reserve a plan key adversarially",
      relatedIds: [],
    });
    await expect(
      service.planAction({
        idempotencyKey: reserved.idempotencyKey!,
        kind: "interaction",
        intent: "Must collide before planning",
        tool: "chrome-devtools-mcp",
        target: { description: "Page" },
      }),
    ).rejects.toMatchObject({ code: "event.idempotency_conflict" });
    const input = {
      idempotencyKey: "submit-login",
      kind: "interaction" as const,
      intent: "Submit login",
      tool: "chrome-devtools-mcp",
      target: { description: "Login button" },
    };
    const planned = await service.planAction(input);
    const plannedRetry = await service.planAction(input);
    expect(plannedRetry).toEqual(planned);

    await expect(
      service.planAction({ ...input, intent: "Submit a different form" }),
    ).rejects.toMatchObject({ code: "event.idempotency_conflict" });

    const terminalInput = {
      actionId: planned.id,
      phase: "completed" as const,
      toolResult: { summary: "Login submitted", data: { status: 200 } },
    };
    const completed = await service.completeAction(terminalInput);
    expect(completed.idempotencyKey).toBe(`complete:${planned.id}`);
    expect(await service.completeAction(terminalInput)).toEqual(completed);
    await expect(
      service.completeAction({
        actionId: planned.id,
        phase: "unknown",
        toolResult: { summary: "Result became ambiguous" },
      }),
    ).rejects.toMatchObject({ code: "action.terminal_conflict" });

    const another = await service.planAction({
      ...input,
      idempotencyKey: "another-action",
    });
    await service.planAction({
      idempotencyKey: `complete:${another.id}`,
      kind: "interaction",
      intent: "Reserve the completion key adversarially",
      tool: "chrome-devtools-mcp",
      target: { description: "Another button" },
    });
    await expect(
      service.completeAction({
        actionId: another.id,
        phase: "completed",
        toolResult: { summary: "Completed" },
      }),
    ).rejects.toMatchObject({ code: "event.idempotency_conflict" });
  });

  it("serializes concurrent action retries to one plan and terminal event", async () => {
    const { service, repository } = await createTrustedRun();
    const input = {
      idempotencyKey: "concurrent-plan",
      kind: "interaction" as const,
      intent: "Perform one concurrent action",
      tool: "chrome-devtools-mcp",
      target: { description: "Button" },
    };
    const [firstPlan, secondPlan] = await Promise.all([
      service.planAction(input),
      service.planAction(input),
    ]);
    expect(secondPlan).toEqual(firstPlan);

    const terminalInput = {
      actionId: firstPlan.id,
      phase: "completed" as const,
      toolResult: { summary: "Completed once" },
    };
    const [firstTerminal, secondTerminal] = await Promise.all([
      service.completeAction(terminalInput),
      service.completeAction(terminalInput),
    ]);
    expect(secondTerminal).toEqual(firstTerminal);
    const events = await repository.journal("run-1").readAll();
    expect(
      events.filter((event) => event.idempotencyKey === "concurrent-plan"),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.idempotencyKey === `complete:${firstPlan.id}`,
      ),
    ).toHaveLength(1);
  });

  it("validates trust before malformed project state and strictly parses input", async () => {
    const { projectRoot, service } = await createTrustedRun();
    const paths = resolveRunPaths(projectRoot, "run-1");
    await writeFile(paths.workOrder, "not-json", "utf8");
    const untrustedHome = await mkdtemp(
      join(tmpdir(), "ai-qa-protocol-untrusted-home-"),
    );
    const untrusted = new RunProtocolService(
      projectRoot,
      untrustedHome,
      "run-1",
      fixedNow,
    );
    await expect(
      untrusted.planAction({
        idempotencyKey: "must-not-read",
        kind: "interaction",
        intent: "Do not read malformed state",
        tool: "chrome-devtools-mcp",
        target: { description: "Page" },
      }),
    ).rejects.toMatchObject({ code: "trust.not_trusted" });

    await expect(
      service.planAction({
        idempotencyKey: "strict-input",
        kind: "interaction",
        intent: "Reject unknown keys",
        tool: "chrome-devtools-mcp",
        target: { description: "Page" },
        extra: true,
      } as never),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("enforces exact deadline, total tool-call, and recovery-action budgets", async () => {
    const toolBudget = await createSmallBudgetRun({
      maxToolCalls: 1,
      maxRecoveryActions: 1,
    });
    const firstInput = {
      idempotencyKey: "only-tool-call",
      kind: "interaction" as const,
      intent: "Use the only call",
      tool: "chrome-devtools-mcp",
      target: { description: "Page" },
    };
    const first = await toolBudget.service.planAction(firstInput);
    expect(await toolBudget.service.planAction(firstInput)).toEqual(first);
    await expect(
      toolBudget.service.planAction({
        ...firstInput,
        idempotencyKey: "over-tool-budget",
      }),
    ).rejects.toMatchObject({ code: "run.tool_call_budget_exhausted" });

    const deadline = await createSmallBudgetRun({
      maxToolCalls: 4,
      maxRecoveryActions: 1,
    });
    deadline.clock.current = new Date("2026-07-13T00:10:00.000Z");
    await expect(
      deadline.service.planAction({
        ...firstInput,
        idempotencyKey: "at-exact-deadline",
      }),
    ).rejects.toMatchObject({ code: "run.deadline_exhausted" });

    const recoveryBudget = await createSmallBudgetRun({
      maxToolCalls: 4,
      maxRecoveryActions: 1,
    });
    const base = await recoveryBudget.service.planAction({
      ...firstInput,
      idempotencyKey: "base-step",
    });
    await recoveryBudget.service.completeAction({
      actionId: base.id,
      phase: "completed",
      toolResult: { summary: "Base step completed before recovery" },
    });
    const stepId = (base.payload as { stepId: string }).stepId;
    await recoveryBudget.service.planAction({
      ...firstInput,
      idempotencyKey: "first-recovery",
      recoveryForStepId: stepId,
    });
    await expect(
      recoveryBudget.service.planAction({
        ...firstInput,
        idempotencyKey: "second-recovery",
        recoveryForStepId: stepId,
      }),
    ).rejects.toMatchObject({ code: "run.recovery_budget_exhausted" });
    await expect(
      recoveryBudget.service.planAction({
        ...firstInput,
        idempotencyKey: "unknown-step-recovery",
        recoveryForStepId: "step-missing",
      }),
    ).rejects.toMatchObject({ code: "action.step_not_found" });
  });

  it("validates and persists a plan with one locked append timestamp", async () => {
    const { projectRoot, aiQaHome } = await createTrustedRun();
    let clockReads = 0;
    const crossingClock = () => {
      clockReads += 1;
      return clockReads === 1
        ? new Date("2026-07-13T00:29:59.999Z")
        : new Date("2026-07-13T00:30:00.000Z");
    };
    const service = new RunProtocolService(
      projectRoot,
      aiQaHome,
      "run-1",
      crossingClock,
    );
    const planned = await service.planAction({
      idempotencyKey: "deadline-crossing-plan",
      kind: "interaction",
      intent: "Use one timestamp for validation and persistence",
      tool: "chrome-devtools-mcp",
      target: { description: "Page" },
    });
    expect(clockReads).toBe(1);
    expect(planned.timestamp).toBe("2026-07-13T00:29:59.999Z");
    await expect(
      service.recordDecision({
        kind: "semantic",
        rationale: "The prior plan remains semantically valid",
        relatedIds: [planned.id],
      }),
    ).resolves.toMatchObject({ type: "decision" });
  });

  it("requires a completed observation action and preserves its step", async () => {
    const { service } = await createTrustedRun();
    const action = await service.planAction({
      idempotencyKey: "observe-page",
      kind: "observation",
      intent: "Observe page",
      tool: "chrome-devtools-mcp",
      target: { description: "Page" },
    });
    await expect(
      service.addObservation({
        actionId: action.id,
        summary: "Premature observation",
        state: {},
      }),
    ).rejects.toMatchObject({ code: "action.completed_action_required" });
    await service.completeAction({
      actionId: action.id,
      phase: "completed",
      toolResult: { summary: "Observed" },
    });
    await expect(
      service.addObservation({
        actionId: action.id,
        summary: "Wrong step",
        state: {},
        stepId: "step-different",
      }),
    ).rejects.toMatchObject({ code: "observation.step_mismatch" });
    const observation = await service.addObservation({
      actionId: action.id,
      summary: "Page is visible",
      state: { visible: true },
    });
    expect(observation.payload).toMatchObject({
      actionId: action.id,
      stepId: (action.payload as { stepId: string }).stepId,
    });
    expect(
      await service.addObservation({
        actionId: action.id,
        summary: "Page is visible",
        state: { visible: true },
      }),
    ).toEqual(observation);

    const interaction = await service.planAction({
      idempotencyKey: "click-not-observe",
      kind: "interaction",
      intent: "Click",
      tool: "chrome-devtools-mcp",
      target: { description: "Button" },
    });
    await service.completeAction({
      actionId: interaction.id,
      phase: "completed",
      toolResult: { summary: "Clicked" },
    });
    await expect(
      service.addObservation({
        actionId: interaction.id,
        summary: "Not an observation action",
        state: {},
      }),
    ).rejects.toMatchObject({ code: "observation.action_required" });
  });

  it("requires criterion, observation, and evidence citations for assertions", async () => {
    const { projectRoot, aiQaHome, service } = await createTrustedRun();
    const observation = await addCurrentObservation(service, "assert-observe");
    const capture = await service.planAction({
      idempotencyKey: "capture-proof",
      kind: "evidence-capture",
      intent: "Capture screenshot",
      tool: "chrome-devtools-mcp",
      target: { description: "Authenticated home" },
      stepId: observation.stepId,
    });
    await service.completeAction({
      actionId: capture.id,
      phase: "completed",
      toolResult: { summary: "Screenshot captured" },
    });
    const sourcePath = join(projectRoot, "home.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
    const evidence = await registerEvidence({
      projectRoot,
      aiQaHome,
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
      observationIds: [observation.eventId],
      now: fixedNow,
    });
    const assertionInput = {
      criterionId: "authenticated-home-visible",
      status: "satisfied" as const,
      assertionKinds: ["semantic-ui"],
      actual: "Authenticated home is visible",
      expected: "Authenticated home is visible",
      observationIds: [observation.eventId],
      evidenceIds: [evidence.id],
      stepId: observation.stepId,
    };
    const assertion = await service.recordAssertion(assertionInput);
    expect(assertion.type).toBe("assertion");
    expect(await service.recordAssertion(assertionInput)).toEqual(assertion);

    await expect(
      service.recordAssertion({
        ...assertionInput,
        criterionId: "unknown-criterion",
      }),
    ).rejects.toMatchObject({ code: "assertion.citation_invalid" });
    await expect(
      service.recordAssertion({
        ...assertionInput,
        observationIds: ["event-missing-observation"],
      }),
    ).rejects.toMatchObject({ code: "assertion.citation_invalid" });
    await expect(
      service.recordAssertion({
        ...assertionInput,
        evidenceIds: ["evidence-missing-record"],
      }),
    ).rejects.toMatchObject({ code: "assertion.citation_invalid" });
    await expect(
      service.recordAssertion({
        ...assertionInput,
        assertionKinds: [],
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("records strict semantic decisions idempotently", async () => {
    const { service } = await createTrustedRun();
    const input = {
      kind: "semantic" as const,
      rationale: "The navigation completed successfully",
      relatedIds: ["authenticated-home-visible"],
    };
    const decision = await service.recordDecision(input);
    expect(decision.type).toBe("decision");
    expect(await service.recordDecision(input)).toEqual(decision);
    await expect(
      service.recordDecision({ ...input, unknown: true } as never),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("requires a later strict observation and makes recovery resolution immutable", async () => {
    const { service } = await createTrustedRun();
    const oldObservation = await addCurrentObservation(service, "old-observe");
    const action = await service.planAction({
      idempotencyKey: "ambiguous-submit",
      kind: "interaction",
      intent: "Submit form",
      tool: "chrome-devtools-mcp",
      target: { description: "Submit button" },
    });
    await service.completeAction({
      actionId: action.id,
      phase: "unknown",
      toolResult: { summary: "Connection closed" },
    });
    await expect(
      service.planAction({
        idempotencyKey: "blind-retry",
        kind: "interaction",
        intent: "Do not retry before recovery",
        tool: "chrome-devtools-mcp",
        target: { description: "Submit button" },
        recoveryForStepId: (action.payload as { stepId: string }).stepId,
      }),
    ).rejects.toMatchObject({ code: "recovery.retry_not_permitted" });
    await expect(
      service.resolveUnknownAction({
        actionId: action.id,
        resolution: "indeterminate",
        observationId: oldObservation.eventId,
        rationale: "Observation predates the ambiguous action",
      }),
    ).rejects.toMatchObject({ code: "recovery.fresh_observation_required" });

    const fresh = await addCurrentObservation(service, "fresh-observe");
    const recoveryInput = {
      actionId: action.id,
      resolution: "indeterminate" as const,
      observationId: fresh.eventId,
      rationale: "The UI cannot establish whether submission occurred",
    };
    const recovery = await service.resolveUnknownAction(recoveryInput);
    expect(recovery.idempotencyKey).toBe(`recovery:${action.id}`);
    expect(await service.resolveUnknownAction(recoveryInput)).toEqual(recovery);
    await expect(
      service.resolveUnknownAction({
        ...recoveryInput,
        resolution: "applied",
      }),
    ).rejects.toMatchObject({ code: "recovery.resolution_conflict" });
    await expect(
      service.planAction({
        idempotencyKey: "indeterminate-retry",
        kind: "interaction",
        intent: "Do not retry an indeterminate action",
        tool: "chrome-devtools-mcp",
        target: { description: "Submit button" },
        recoveryForStepId: (action.payload as { stepId: string }).stepId,
      }),
    ).rejects.toMatchObject({ code: "recovery.retry_not_permitted" });
  });

  it("consumes not_applied permission and tracks unknown recovery attempts on the original step", async () => {
    const { service } = await createTrustedRun();
    const original = await service.planAction({
      idempotencyKey: "original-ambiguous-action",
      kind: "interaction",
      intent: "Submit the original action",
      tool: "chrome-devtools-mcp",
      target: { description: "Submit button" },
    });
    const originalStepId = (original.payload as { stepId: string }).stepId;
    await service.completeAction({
      actionId: original.id,
      phase: "unknown",
      toolResult: { summary: "Original result is unknown" },
    });
    const originalObservation = await addCurrentObservation(
      service,
      "observe-original-unknown",
    );
    await service.resolveUnknownAction({
      actionId: original.id,
      resolution: "not_applied",
      observationId: originalObservation.eventId,
      rationale: "The original action was not applied",
    });
    await expect(
      service.planAction({
        idempotencyKey: "marker-omission",
        kind: "interaction",
        intent: "Do not bypass the recovery marker",
        tool: "chrome-devtools-mcp",
        target: { description: "Submit button" },
        stepId: originalStepId,
      }),
    ).rejects.toMatchObject({ code: "recovery.marker_required" });

    const retry = await service.planAction({
      idempotencyKey: "first-retry",
      kind: "interaction",
      intent: "Retry after not_applied",
      tool: "chrome-devtools-mcp",
      target: { description: "Submit button" },
      recoveryForStepId: originalStepId,
    });
    expect((retry.payload as { stepId: string }).stepId).toBe(originalStepId);
    await service.completeAction({
      actionId: retry.id,
      phase: "unknown",
      toolResult: { summary: "Retry result is also unknown" },
    });
    await expect(
      service.planAction({
        idempotencyKey: "blind-second-retry",
        kind: "interaction",
        intent: "Must observe the unknown retry first",
        tool: "chrome-devtools-mcp",
        target: { description: "Submit button" },
        recoveryForStepId: originalStepId,
      }),
    ).rejects.toMatchObject({ code: "recovery.retry_not_permitted" });

    const retryObservation = await addCurrentObservation(
      service,
      "observe-unknown-retry",
    );
    await service.resolveUnknownAction({
      actionId: retry.id,
      resolution: "not_applied",
      observationId: retryObservation.eventId,
      rationale: "The retry was also not applied",
    });
    await expect(
      service.planAction({
        idempotencyKey: "resolved-second-retry",
        kind: "interaction",
        intent: "Retry only after resolving the latest unknown",
        tool: "chrome-devtools-mcp",
        target: { description: "Submit button" },
        recoveryForStepId: originalStepId,
      }),
    ).resolves.toMatchObject({ type: "action" });
  });

  it("rejects schema-valid orphan observations before they can support assertions", async () => {
    const { service, repository } = await createTrustedRun();
    const forged = await repository.journal("run-1").append({
      type: "observation",
      actor: "agent",
      platform: "web",
      tool: "chrome-devtools-mcp",
      idempotencyKey: "observation:event-missing-action",
      payload: {
        actionId: "event-missing-action",
        stepId: "step-forged",
        summary: "Forged but schema-valid observation",
        state: { visible: true },
      },
      relatedIds: ["event-missing-action"],
    });
    await expect(
      service.recordAssertion({
        criterionId: "authenticated-home-visible",
        status: "satisfied",
        assertionKinds: ["semantic-ui"],
        actual: "Forged observation claims success",
        expected: "Authenticated home is visible",
        observationIds: [forged.id],
        evidenceIds: [],
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
  });

  it("rejects malformed typed events before appending more protocol state", async () => {
    const { service, repository } = await createTrustedRun();
    await repository.journal("run-1").append({
      type: "action",
      actor: "agent",
      platform: "web",
      tool: "chrome-devtools-mcp",
      idempotencyKey: "malformed-action",
      payload: { phase: "planned", intent: "missing required fields" },
      relatedIds: [],
    });
    await expect(
      service.planAction({
        idempotencyKey: "after-malformed",
        kind: "interaction",
        intent: "Must not append",
        tool: "chrome-devtools-mcp",
        target: { description: "Page" },
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
  });

  it("exposes typed CLI output for protocol commands", async () => {
    const { projectRoot, aiQaHome } = await createTrustedRun();
    const body = JSON.stringify({
      idempotencyKey: "cli-observe",
      kind: "observation",
      intent: "Observe through CLI",
      tool: "chrome-devtools-mcp",
      target: { description: "Page" },
    });
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(body),
    });
    expect(
      await runCli(
        [
          "--project",
          projectRoot,
          "action",
          "plan",
          "--run",
          "run-1",
          "--stdin-json",
        ],
        captured.context,
      ),
    ).toBe(0);
    expect(captured.stderr).toEqual([]);
    const output = JSON.parse(captured.stdout[0]!) as {
      eventId: string;
      sequence: number;
      payload: { phase: string };
      permittedNextActions: string[];
    };
    expect(output.eventId).toMatch(/^event-/);
    expect(output).toMatchObject({
      sequence: 2,
      payload: { phase: "planned" },
      permittedNextActions: ["invoke-tool", "action.complete"],
    });
  });

  it("does not expose a generic event command", () => {
    const captured = createCapturedCli();
    const program = createProgram(captured.context);
    const commandNames = program.commands.map((command) => command.name());
    expect(commandNames).toEqual(
      expect.arrayContaining([
        "action",
        "observation",
        "assertion",
        "decision",
        "recovery",
      ]),
    );
    const subcommands = (name: string) =>
      program.commands
        .find((command) => command.name() === name)!
        .commands.map((command) => command.name());
    expect(subcommands("action")).toEqual(["plan", "complete"]);
    expect(subcommands("observation")).toEqual(["add"]);
    expect(subcommands("assertion")).toEqual(["record"]);
    expect(subcommands("decision")).toEqual(["record"]);
    expect(subcommands("recovery")).toEqual(["resolve"]);
    expect(commandNames.some((commandName) => commandName === "event")).toBe(
      false,
    );
  });
});
