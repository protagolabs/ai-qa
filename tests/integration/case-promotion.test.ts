import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { sha256Canonical } from "../../src/core/canonical-json.js";
import { CaseRepository } from "../../src/core/cases/repository.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
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
import { initializeProject } from "../../src/services/initialization/initialize-project.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { VerdictService } from "../../src/services/run-protocol/verdict-service.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { createCapturedCli } from "../helpers/cli-context.js";

const startedAt = new Date("2026-07-13T00:00:00.000Z");
const runNow = () => new Date("2026-07-13T00:10:00.000Z");
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

async function createCompletedPassRun(
  options: {
    extraInteraction?: boolean;
    mislinkedStructuredProof?: boolean;
  } = {},
): Promise<{
  projectRoot: string;
  aiQaHome: string;
  plannedActionId: string;
  extraActionId?: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-project-"));
  const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-case-home-"));
  await confirmProjectTrust({
    projectRoot,
    aiQaHome,
    confirmed: true,
    now: startedAt,
  });
  await initializeProject({ projectRoot, aiQaHome, config });
  const repository = new RunRepository(projectRoot, () => startedAt);
  await repository.create(
    createExploratoryWorkOrder({
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
  const protocol = new RunProtocolService(
    projectRoot,
    aiQaHome,
    "run-source",
    runNow,
  );
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
      aiQaHome,
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
  await protocol.completeAction({
    actionId: planned.id,
    phase: "completed",
    toolResult: { summary: "Credentials submitted" },
  });
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
  const stepId = (planned.payload as { stepId: string }).stepId;
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
    aiQaHome,
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
  const verdict = new VerdictService(
    projectRoot,
    aiQaHome,
    "run-source",
    runNow,
  );
  await verdict.set({
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
  await finalizeRun({
    projectRoot,
    aiQaHome,
    runId: "run-source",
    now: runNow,
  });
  return {
    projectRoot,
    aiQaHome,
    plannedActionId: planned.id,
    ...(extraAction === undefined ? {} : { extraActionId: extraAction.id }),
  };
}

async function createCompletedUnknownRun(): Promise<{
  projectRoot: string;
  plannedActionId: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-unknown-"));
  const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-case-home-"));
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
  const protocol = new RunProtocolService(
    projectRoot,
    aiQaHome,
    "run-unknown",
    runNow,
  );
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
  const verdict = new VerdictService(
    projectRoot,
    aiQaHome,
    "run-unknown",
    runNow,
  );
  await verdict.set({
    classification: "not_verified",
    reasonCode: "unknown_action",
    summary: "Submission outcome could not be verified",
    criterionResults: [],
  });
  await finalizeRun({
    projectRoot,
    aiQaHome,
    runId: "run-unknown",
    now: runNow,
  });
  return { projectRoot, plannedActionId: planned.id };
}

describe("case promotion", () => {
  it("serializes concurrent creators through first-index bootstrap", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-case-concurrent-"));
    const repository = new CaseRepository(projectRoot, runNow);
    const input = {
      schemaVersion: 1 as const,
      caseId: "concurrent-case",
      title: "Concurrent case",
      promotion: { sourceRunId: "run-source", validationIssues: [] },
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
      promotion: { sourceRunId: "run-source", validationIssues: [] },
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
        promotion: { sourceRunId: "run-source", validationIssues: [] },
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
        webSteps: [
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
      promotion: { sourceRunId: "run-source", validationIssues: [] },
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
        webSteps: [
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
        webSteps: [
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
        webSteps: [
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

    expect(
      (
        draft.promotion as typeof draft.promotion & {
          excludedActions?: Array<{ actionId: string; reason: string }>;
        }
      ).excludedActions,
    ).toEqual([
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
      promotion: { sourceRunId: "run-source", validationIssues: [] },
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
        webSteps: [
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
        webSteps: [
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
        webSteps: [
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
    const { projectRoot, aiQaHome, plannedActionId } =
      await createCompletedPassRun();
    const draft = await draftCaseFromRun({
      projectRoot,
      runId: "run-source",
      input: {
        caseId: "cli-activation",
        title: "CLI activation",
        webSteps: [
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
      env: { AI_QA_HOME: aiQaHome },
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
      env: { AI_QA_HOME: aiQaHome },
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
    expect(JSON.parse(confirmed.stdout.join(""))).toMatchObject({
      caseId: draft.caseId,
      activeRevision: draft.revision,
      contentHash: draft.contentHash,
      activation: { confirmedBy: "user" },
    });
    const retried = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: aiQaHome },
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
    ) as { revisions: Array<{ activation?: unknown }> };
    expect(index.revisions[0]!.activation).toEqual(retryOutput.activation);
  });

  it("drafts and validates immutable revisions through the public case command", async () => {
    const { projectRoot, aiQaHome, plannedActionId } =
      await createCompletedPassRun();
    const drafted = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            caseId: "cli-draft",
            title: "CLI draft",
            webSteps: [
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
      env: { AI_QA_HOME: aiQaHome },
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
