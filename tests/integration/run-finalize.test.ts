import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";
import { finalizeRun } from "../../src/services/run-protocol/finalize-run.js";
import { initializeProject } from "../../src/services/initialization/initialize-project.js";
import { createPreflightResultRun } from "../../src/services/run-protocol/create-preflight-result-run.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import {
  cancelRun,
  resumeRun,
} from "../../src/services/run-protocol/run-lifecycle.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { VerdictService } from "../../src/services/run-protocol/verdict-service.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { createCapturedCli } from "../helpers/cli-context.js";

const now = () => new Date("2026-07-13T00:10:00.000Z");
const startedAt = new Date("2026-07-13T00:00:00.000Z");

const config: ProjectConfig = {
  schemaVersion: 1,
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
  secretReferences: {},
};

async function createRun() {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-finalize-project-"));
  const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-finalize-home-"));
  await confirmProjectTrust({
    projectRoot,
    aiQaHome,
    confirmed: true,
    now: startedAt,
  });
  const repository = new RunRepository(projectRoot, () => startedAt);
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
      startedAt,
    }),
  );
  return {
    projectRoot,
    aiQaHome,
    repository,
    protocol: new RunProtocolService(projectRoot, aiQaHome, "run-1", now),
    verdicts: new VerdictService(projectRoot, aiQaHome, "run-1", now),
  };
}

async function createPreflightProject() {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-preflight-project-"));
  const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-preflight-home-"));
  await confirmProjectTrust({
    projectRoot,
    aiQaHome,
    confirmed: true,
    now: startedAt,
  });
  await initializeProject({ projectRoot, aiQaHome, config });
  return { projectRoot, aiQaHome };
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
    aiQaHome: fixture.aiQaHome,
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

describe("finalizeRun", () => {
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
        aiQaHome: fixture.aiQaHome,
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
        aiQaHome: fixture.aiQaHome,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "verdict.unsupported_pass" });
  });

  it("verifies evidence bytes before completing and remains idempotent", async () => {
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
      aiQaHome: fixture.aiQaHome,
      runId: "run-1",
      now,
    });
    expect(result).toMatchObject({
      runId: "run-1",
      status: "completed",
      verdict: "pass",
    });
    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        aiQaHome: fixture.aiQaHome,
        runId: "run-1",
        now,
      }),
    ).resolves.toEqual(result);
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
        aiQaHome: fixture.aiQaHome,
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
        aiQaHome: fixture.aiQaHome,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "verdict.unsupported_not_verified" });
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
        aiQaHome: fixture.aiQaHome,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });
});

describe("run lifecycle", () => {
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
        aiQaHome: fixture.aiQaHome,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });

  it("requires a fresh observation after resume before interaction", async () => {
    const fixture = await createRun();

    await expect(
      resumeRun({
        projectRoot: fixture.projectRoot,
        aiQaHome: fixture.aiQaHome,
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
        aiQaHome: fixture.aiQaHome,
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
        aiQaHome: fixture.aiQaHome,
        runId: "run-1",
        now,
      }),
    ).rejects.toMatchObject({ code: "run.cancelled" });
    await expect(
      resumeRun({
        projectRoot: fixture.projectRoot,
        aiQaHome: fixture.aiQaHome,
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
});

describe("preflight result runs", () => {
  it("completes a failed global-skill preflight as blocked:tool", async () => {
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
              code: "agent.global_skill",
              status: "fail",
              message: "Global skill status: stale",
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
            code: "agent.global_skill",
            status: "fail",
            message: "Global skill status: stale",
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
      env: { AI_QA_HOME: fixture.aiQaHome },
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
      env: { AI_QA_HOME: fixture.aiQaHome },
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
