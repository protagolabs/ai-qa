import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseRepository } from "../../src/core/cases/repository.js";
import type { Platform } from "../../src/core/platforms/schema.js";
import { runGroupReportSchema } from "../../src/core/reports/group-schema.js";
import { runGroupManifestSchema } from "../../src/core/run-groups/schema.js";
import type { WorkOrder } from "../../src/core/runs/schema.js";
import {
  exportProjectLocalGroupReport,
  generateRunGroupReport,
} from "../../src/services/report-generation/generate-group-report.js";
import { generateRunReport } from "../../src/services/report-generation/generate-run-report.js";
import {
  readGroupRecordingStatus,
  registerGroupRecordingReceipt,
} from "../../src/services/report-generation/recording-receipt.js";
import { renderRunGroupReportMarkdown } from "../../src/services/report-generation/render-group-markdown.js";
import { finishRunGroup } from "../../src/services/run-groups/finish-run-group.js";
import { startRunGroup } from "../../src/services/run-groups/start-run-group.js";
import { finalizeRun } from "../../src/services/run-protocol/finalize-run.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { VerdictService } from "../../src/services/run-protocol/verdict-service.js";
import {
  initializeTestProject,
  projectConfig,
} from "../helpers/project-fixture.js";

const startedAt = new Date("2026-07-17T00:00:00.000Z");
const now = () => new Date("2026-07-17T00:05:00.000Z");
const selectedPlatforms = ["web", "ios-simulator", "android-emulator"] as const;

function controller(platform: "web" | "ios-simulator") {
  return platform === "web"
    ? ("chrome-devtools-mcp" as const)
    : ("pepper" as const);
}

function step(platform: "web" | "ios-simulator") {
  return {
    id: `step-login-${platform === "web" ? "web" : "ios"}`,
    sourceActionId: `event-source-${platform}`,
    intent: `Exercise login on ${platform}`,
    tool: controller(platform),
    target: {
      description: `${platform} login control`,
      stability: "stable" as const,
      stabilityRationale: "Fixture-owned stable target",
    },
    expectedState: "Authenticated home is visible",
    assertionStrategy: "Observe the authenticated home",
    evidenceCheckpoints: ["post-action-screenshot"],
  };
}

function readiness(platform: Platform) {
  return {
    platform,
    status: "ready" as const,
    checks: [
      {
        code: `${platform}.ready`,
        status: "pass" as const,
        message: `${platform} is ready`,
        category: "tool" as const,
      },
    ],
  };
}

async function groupFixture(
  mode: "local-only" | "project-skill" = "local-only",
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-group-report-"));
  await initializeTestProject({
    projectRoot,
    config: projectConfig([...selectedPlatforms], mode),
  });
  const cases = new CaseRepository(projectRoot, now);
  const revision = await cases.createDraft({
    schemaVersion: 2,
    caseId: "login",
    title: "Login",
    promotion: {
      sources: {
        web: { sourceRunId: "run-source-web" },
        "ios-simulator": { sourceRunId: "run-source-ios" },
      },
      validationIssues: [],
    },
    acceptanceCriteria: [
      {
        id: "home-visible",
        description: "Authenticated home is visible",
        requiredEvidence: ["post-action-screenshot"],
      },
    ],
    variants: {
      web: { steps: [step("web")] },
      "ios-simulator": { steps: [step("ios-simulator")] },
    },
  });
  await cases.activate("login", revision.revision, {
    confirmedBy: "user",
    confirmedAt: startedAt.toISOString(),
  });
  const started = await startRunGroup({
    projectRoot,
    selection: { mode: "explicit", caseIds: ["login"] },
    platforms: [...selectedPlatforms],
    execution: "local",
    readiness: Object.fromEntries(
      selectedPlatforms.map((platform) => [platform, readiness(platform)]),
    ),
    now: () => startedAt,
  });
  return { projectRoot, revision, started };
}

function memberFor(
  fixture: Awaited<ReturnType<typeof groupFixture>>,
  platform: "web" | "ios-simulator",
) {
  const member = fixture.started.manifest.members.find(
    (candidate) => candidate.platform === platform,
  );
  if (member === undefined) throw new Error(`Missing ${platform} member`);
  return member;
}

async function completePass(
  fixture: Awaited<ReturnType<typeof groupFixture>>,
): Promise<void> {
  const member = memberFor(fixture, "web");
  const protocol = new RunProtocolService(
    fixture.projectRoot,
    member.runId,
    now,
  );
  const required = member.workOrder.requiredSteps[0]!;
  const interaction = await protocol.planAction({
    idempotencyKey: "web-login",
    kind: "interaction",
    intent: required.intent,
    tool: required.tool,
    target: { description: required.target.description },
    stepId: required.id,
  });
  await protocol.completeAction({
    actionId: interaction.id,
    phase: "completed",
    toolResult: { summary: "Login completed" },
  });
  const observationAction = await protocol.planAction({
    idempotencyKey: "web-observe",
    kind: "observation",
    intent: "Observe authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Authenticated home" },
    stepId: required.id,
  });
  await protocol.completeAction({
    actionId: observationAction.id,
    phase: "completed",
    toolResult: { summary: "Home observed" },
  });
  const observation = await protocol.addObservation({
    actionId: observationAction.id,
    summary: "Authenticated home is visible",
    state: { visible: true },
  });
  const capture = await protocol.planAction({
    idempotencyKey: "web-capture",
    kind: "evidence-capture",
    intent: "Capture authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Authenticated home" },
    stepId: required.id,
  });
  await protocol.completeAction({
    actionId: capture.id,
    phase: "completed",
    toolResult: { summary: "Screenshot captured" },
  });
  const sourcePath = join(fixture.projectRoot, "web-home.png");
  await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
  const evidence = await registerEvidence({
    projectRoot: fixture.projectRoot,
    runId: member.runId,
    payload: {
      sourcePath,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: capture.id,
      idempotencyKey: "web-home-evidence",
    },
    criterionIds: ["home-visible"],
    observationIds: [observation.id],
    now,
  });
  const assertion = await protocol.recordAssertion({
    criterionId: "home-visible",
    status: "satisfied",
    assertionKinds: ["semantic-ui"],
    actual: "Authenticated home is visible",
    expected: "Authenticated home is visible",
    observationIds: [observation.id],
    evidenceIds: [evidence.id],
    stepId: required.id,
  });
  await new VerdictService(fixture.projectRoot, member.runId, now).set({
    classification: "pass",
    summary: "Web login passed",
    criterionResults: [
      {
        criterionId: "home-visible",
        status: "satisfied",
        assertionIds: [assertion.id],
        evidenceIds: [evidence.id],
      },
    ],
  });
  await finalizeRun({
    projectRoot: fixture.projectRoot,
    runId: member.runId,
    now,
  });
}

async function completeBlocked(
  fixture: Awaited<ReturnType<typeof groupFixture>>,
): Promise<void> {
  const member = memberFor(fixture, "ios-simulator");
  const protocol = new RunProtocolService(
    fixture.projectRoot,
    member.runId,
    now,
  );
  const required = member.workOrder.requiredSteps[0]!;
  const interaction = await protocol.planAction({
    idempotencyKey: "ios-login",
    kind: "interaction",
    intent: required.intent,
    tool: required.tool,
    target: { description: required.target.description },
    stepId: required.id,
  });
  await protocol.completeAction({
    actionId: interaction.id,
    phase: "unknown",
    toolResult: { summary: "Pepper stopped responding" },
  });
  const observationAction = await protocol.planAction({
    idempotencyKey: "ios-observe",
    kind: "observation",
    intent: "Inspect state after the tool failure",
    tool: "pepper",
    target: { description: "Current simulator screen" },
    stepId: required.id,
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
    rationale: "The controller cannot establish whether login applied",
  });
  const verdicts = new VerdictService(fixture.projectRoot, member.runId, now);
  const blocker = await verdicts.recordBlocker({
    subtype: "tool",
    condition: "Pepper stopped responding",
    attemptEventIds: [interaction.id],
    criterionIds: ["home-visible"],
  });
  await verdicts.set({
    classification: "blocked",
    blockerSubtype: "tool",
    blockerIds: [blocker.id],
    summary: "iOS login was blocked by the controller",
    criterionResults: [],
  });
  await finalizeRun({
    projectRoot: fixture.projectRoot,
    runId: member.runId,
    now,
  });
}

async function completedFixture(
  mode: "local-only" | "project-skill" = "local-only",
) {
  const fixture = await groupFixture(mode);
  await completePass(fixture);
  await completeBlocked(fixture);
  await finishRunGroup({
    projectRoot: fixture.projectRoot,
    runGroupId: fixture.started.manifest.id,
    now,
  });
  return fixture;
}

async function allExclusionProjectSkillFixture() {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "ai-qa-group-report-exclusions-"),
  );
  await initializeTestProject({
    projectRoot,
    config: projectConfig(["android-emulator"], "project-skill"),
  });
  const cases = new CaseRepository(projectRoot, now);
  const revision = await cases.createDraft({
    schemaVersion: 2,
    caseId: "web-only",
    title: "Web only",
    promotion: {
      sources: { web: { sourceRunId: "run-source-web" } },
      validationIssues: [],
    },
    acceptanceCriteria: [
      {
        id: "home-visible",
        description: "Authenticated home is visible",
        requiredEvidence: ["post-action-screenshot"],
      },
    ],
    variants: { web: { steps: [step("web")] } },
  });
  await cases.activate("web-only", revision.revision, {
    confirmedBy: "user",
    confirmedAt: startedAt.toISOString(),
  });
  const started = await startRunGroup({
    projectRoot,
    selection: { mode: "explicit", caseIds: ["web-only"] },
    platforms: ["android-emulator"],
    execution: "local",
    readiness: { "android-emulator": readiness("android-emulator") },
    now: () => startedAt,
  });
  await finishRunGroup({
    projectRoot,
    runGroupId: started.manifest.id,
    now,
  });
  return { projectRoot, started };
}

describe("aggregate run-group reports", () => {
  it("renders a complete stable matrix without collapsing it to a verdict", async () => {
    const fixture = await completedFixture();
    const generated = await generateRunGroupReport({
      projectRoot: fixture.projectRoot,
      runGroupId: fixture.started.manifest.id,
      now,
    });

    expect(generated.report.matrix).toEqual([
      expect.objectContaining({
        caseId: "login",
        platform: "web",
        status: "pass",
      }),
      expect.objectContaining({
        caseId: "login",
        platform: "ios-simulator",
        status: "blocked",
        blockerSubtype: "tool",
      }),
      expect.objectContaining({
        caseId: "login",
        platform: "android-emulator",
        status: "coverage_gap",
      }),
    ]);
    expect(generated.report.summary).toEqual({
      pass: 1,
      fail: 0,
      blocked: 1,
      notVerified: 0,
      coverageGap: 1,
    });
    expect(generated.report).not.toHaveProperty("verdict");
  });

  it("keeps JSON and Markdown parity and ignores persisted child report claims", async () => {
    const fixture = await completedFixture();
    const web = memberFor(fixture, "web");
    await generateRunReport({
      projectRoot: fixture.projectRoot,
      runId: web.runId,
      now,
    });
    await writeFile(
      join(
        fixture.projectRoot,
        ".ai-qa",
        "reports",
        "runs",
        web.runId,
        "report.json",
      ),
      '{"tampered":"persisted child claim"}\n',
    );

    const generated = await generateRunGroupReport({
      projectRoot: fixture.projectRoot,
      runGroupId: fixture.started.manifest.id,
      now,
    });
    const json = runGroupReportSchema.parse(
      JSON.parse(
        await readFile(join(fixture.projectRoot, generated.jsonPath!), "utf8"),
      ),
    );
    const markdown = await readFile(
      join(fixture.projectRoot, generated.markdownPath!),
      "utf8",
    );

    expect(json).toEqual(generated.report);
    expect(markdown).toBe(renderRunGroupReportMarkdown(generated.report));
    expect(
      generated.report.matrix.find(
        (cell) => "runId" in cell && cell.runId === web.runId,
      ),
    ).toMatchObject({ status: "pass" });
    await expect(
      exportProjectLocalGroupReport({
        projectRoot: fixture.projectRoot,
        runGroupId: fixture.started.manifest.id,
        now,
      }),
    ).resolves.toEqual({
      jsonPath: generated.jsonPath,
      markdownPath: generated.markdownPath,
    });
  });

  it("rejects canonical child tampering instead of trusting report artifacts", async () => {
    const fixture = await completedFixture();
    const web = memberFor(fixture, "web");
    const workOrderPath = join(
      fixture.projectRoot,
      ".ai-qa",
      "runs",
      web.runId,
      "work-order.json",
    );
    const workOrder = JSON.parse(
      await readFile(workOrderPath, "utf8"),
    ) as WorkOrder;
    await writeFile(
      workOrderPath,
      JSON.stringify({ ...workOrder, projectId: "tampered-project" }),
    );

    await expect(
      generateRunGroupReport({
        projectRoot: fixture.projectRoot,
        runGroupId: fixture.started.manifest.id,
        now,
      }),
    ).rejects.toMatchObject({ code: "work_order.integrity_error" });
  });
});

describe("run-group recording receipts", () => {
  it("rejects a manifest recording context that disagrees with its members", async () => {
    const fixture = await groupFixture("project-skill");

    expect(
      runGroupManifestSchema.safeParse({
        ...fixture.started.manifest,
        recordingPolicy: { mode: "local-only" },
        projectSkill: undefined,
      }).success,
    ).toBe(false);
  });

  it("reports local-only groups as not applicable", async () => {
    const fixture = await completedFixture();
    await generateRunGroupReport({
      projectRoot: fixture.projectRoot,
      runGroupId: fixture.started.manifest.id,
      now,
    });

    await expect(
      readGroupRecordingStatus({
        projectRoot: fixture.projectRoot,
        runGroupId: fixture.started.manifest.id,
        now,
      }),
    ).resolves.toEqual({
      subject: { kind: "run-group", id: fixture.started.manifest.id },
      status: "not_applicable",
      references: [],
    });
  });

  it("registers an unknown Project Skill result idempotently", async () => {
    const fixture = await completedFixture("project-skill");
    await generateRunGroupReport({
      projectRoot: fixture.projectRoot,
      runGroupId: fixture.started.manifest.id,
      now,
    });
    const input = {
      projectRoot: fixture.projectRoot,
      runGroupId: fixture.started.manifest.id,
      now,
      receipt: { status: "unknown" as const, references: [] },
    };

    const first = await registerGroupRecordingReceipt(input);
    const second = await registerGroupRecordingReceipt(input);

    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({
      event: { eventId: first.event.eventId },
      replayed: true,
      status: {
        subject: { kind: "run-group", id: fixture.started.manifest.id },
        status: "unknown",
        references: [],
      },
    });
    await expect(readGroupRecordingStatus(input)).resolves.toEqual(
      first.status,
    );
  });

  it("records an all-exclusion Project Skill group from its frozen manifest snapshot", async () => {
    const fixture = await allExclusionProjectSkillFixture();
    expect(fixture.started.manifest.members).toEqual([]);
    expect(fixture.started.manifest).toMatchObject({
      recordingPolicy: { mode: "project-skill" },
      projectSkill: {
        path: ".agents/skills/ai-qa-project/SKILL.md",
      },
    });
    const generated = await generateRunGroupReport({
      projectRoot: fixture.projectRoot,
      runGroupId: fixture.started.manifest.id,
      now,
    });
    expect(generated.report.summary).toEqual({
      pass: 0,
      fail: 0,
      blocked: 0,
      notVerified: 0,
      coverageGap: 1,
    });
    await expect(
      readGroupRecordingStatus({
        projectRoot: fixture.projectRoot,
        runGroupId: fixture.started.manifest.id,
        now,
      }),
    ).resolves.toEqual({
      subject: { kind: "run-group", id: fixture.started.manifest.id },
      status: "pending",
      references: [],
    });

    const registered = await registerGroupRecordingReceipt({
      projectRoot: fixture.projectRoot,
      runGroupId: fixture.started.manifest.id,
      now,
      receipt: { status: "unknown", references: [] },
    });
    expect(registered).toMatchObject({
      replayed: false,
      event: {
        subject: { kind: "run-group", id: fixture.started.manifest.id },
        status: "unknown",
      },
    });
  });
});
