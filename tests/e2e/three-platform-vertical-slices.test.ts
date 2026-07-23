import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseRepository } from "../../src/core/cases/repository.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { controllerForPlatform } from "../../src/core/platforms/registry.js";
import type { Platform } from "../../src/core/platforms/schema.js";
import type { PlatformReadiness } from "../../src/core/readiness/schema.js";
import type {
  AcceptanceCriterion,
  WorkOrder,
} from "../../src/core/runs/schema.js";
import {
  activateCaseRevision,
  draftCaseFromRun,
  validateCaseRevision,
} from "../../src/services/case-promotion/draft-case.js";
import { runPlatformDoctor } from "../../src/services/doctor/platform-doctor.js";
import { generateRunGroupReport } from "../../src/services/report-generation/generate-group-report.js";
import { generateRunReport } from "../../src/services/report-generation/generate-run-report.js";
import { finishRunGroup } from "../../src/services/run-groups/finish-run-group.js";
import { startRunGroup } from "../../src/services/run-groups/start-run-group.js";
import { finalizeRun } from "../../src/services/run-protocol/finalize-run.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { RunProtocolService } from "../helpers/run-protocol-service.js";
import { startExploratoryRun } from "../../src/services/run-protocol/start-exploratory-run.js";
import { startRegressionRun } from "../../src/services/run-protocol/start-regression-run.js";
import { VerdictService } from "../helpers/verdict-service.js";
import {
  initializeTestProject,
  projectConfig,
} from "../helpers/project-fixture.js";

const platforms = ["web", "ios-simulator", "android-emulator"] as const;
const startedAt = new Date("2026-07-17T08:00:00.000Z");
const now = () => new Date("2026-07-17T08:05:00.000Z");
const criterion: AcceptanceCriterion = {
  id: "home-visible",
  description: "Authenticated home is visible",
  requiredEvidence: ["post-action-screenshot"],
};

function recordedObservation(evidence: string) {
  return {
    status: "ready" as const,
    observedAt: startedAt.toISOString(),
    evidence,
  };
}

async function recordedDoctor(
  config: ProjectConfig,
  platform: Platform,
): Promise<PlatformReadiness> {
  const common = {
    installationChecks: [],
    fetchImpl: (() =>
      Promise.reject(
        new Error("Recorded doctor must not fetch"),
      )) as typeof fetch,
  };
  switch (platform) {
    case "web":
      return runPlatformDoctor({
        ...common,
        platform,
        target: config.targets.web!,
        observations: {
          entryPage: recordedObservation("Host recorded the entry page"),
          chromeDevtoolsMcp: recordedObservation(
            "Host recorded Chrome DevTools MCP readiness",
          ),
        },
      });
    case "ios-simulator":
      return runPlatformDoctor({
        ...common,
        platform,
        target: config.targets[platform]!,
        observations: {
          simulator: recordedObservation("Host recorded a booted Simulator"),
          app: recordedObservation("Host recorded the installed iOS app"),
          pepper: recordedObservation("Host recorded Pepper readiness"),
        },
      });
    case "android-emulator":
      return runPlatformDoctor({
        ...common,
        platform,
        target: config.targets[platform]!,
        tool: config.tools[platform]!,
        observations: {
          emulator: recordedObservation("Host recorded a running Emulator"),
          app: recordedObservation("Host recorded the installed Android app"),
          appium: recordedObservation("Host recorded Appium readiness"),
          uiautomator2: recordedObservation(
            "Host recorded UiAutomator2 readiness",
          ),
        },
      });
  }
}

async function recordPass(input: {
  projectRoot: string;
  workOrder: WorkOrder;
  key: string;
}): Promise<{ interactionId: string }> {
  const tool = controllerForPlatform(input.workOrder.platform);
  const protocol = new RunProtocolService(
    input.projectRoot,
    input.workOrder.runId,
    now,
  );
  const required = input.workOrder.requiredSteps[0];
  const interaction = await protocol.planAction({
    idempotencyKey: `${input.key}-interaction`,
    kind: "interaction",
    intent: required?.intent ?? "Authenticate",
    tool,
    target: { description: required?.target.description ?? "Login control" },
    ...(required === undefined ? {} : { stepId: required.id }),
  });
  await protocol.completeAction({
    actionId: interaction.id,
    phase: "completed",
    toolResult: { summary: "Host recorded controller completion" },
  });
  const stepId = (interaction.payload as { stepId: string }).stepId;
  const observationAction = await protocol.planAction({
    idempotencyKey: `${input.key}-observation`,
    kind: "observation",
    intent: "Observe authenticated home",
    tool,
    target: { description: "Authenticated home" },
    stepId,
  });
  await protocol.completeAction({
    actionId: observationAction.id,
    phase: "completed",
    toolResult: { summary: "Host recorded the fresh observation" },
  });
  const observation = await protocol.addObservation({
    actionId: observationAction.id,
    summary: "Authenticated home is visible",
    state: { visible: true, platform: input.workOrder.platform },
  });
  const capture = await protocol.planAction({
    idempotencyKey: `${input.key}-capture`,
    kind: "evidence-capture",
    intent: "Capture authenticated home",
    tool,
    target: { description: "Authenticated home" },
    stepId,
  });
  await protocol.completeAction({
    actionId: capture.id,
    phase: "completed",
    toolResult: { summary: "Host recorded screenshot capture" },
  });
  const sourcePath = join(input.projectRoot, `${input.key}.png`);
  await writeFile(sourcePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const evidence = await registerEvidence({
    projectRoot: input.projectRoot,
    runId: input.workOrder.runId,
    payload: {
      sourcePath,
      mediaType: "image/png",
      sourceTool: tool,
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: capture.id,
      idempotencyKey: `${input.key}-evidence`,
    },
    criterionIds: [criterion.id],
    observationIds: [observation.id],
    now,
  });
  const assertion = await protocol.recordAssertion({
    criterionId: criterion.id,
    status: "satisfied",
    assertionKinds: ["semantic-ui"],
    actual: criterion.description,
    expected: criterion.description,
    observationIds: [observation.id],
    evidenceIds: [evidence.id],
    stepId,
  });
  await new VerdictService(input.projectRoot, input.workOrder.runId, now).set({
    classification: "pass",
    summary: `${input.workOrder.platform} passed from recorded host evidence`,
    criterionResults: [
      {
        criterionId: criterion.id,
        status: "satisfied",
        assertionIds: [assertion.id],
        evidenceIds: [evidence.id],
      },
    ],
  });
  await finalizeRun({
    projectRoot: input.projectRoot,
    runId: input.workOrder.runId,
    now,
  });
  await generateRunReport({
    projectRoot: input.projectRoot,
    runId: input.workOrder.runId,
    now,
  });
  return { interactionId: interaction.id };
}

describe("recorded three-platform vertical slices", () => {
  it("promotes each platform variant and reports explicit two/three-platform groups", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-three-platform-"));
    const config = projectConfig(platforms);
    await initializeTestProject({ projectRoot, config });
    const readiness = Object.fromEntries(
      await Promise.all(
        platforms.map(async (platform) => [
          platform,
          await recordedDoctor(config, platform),
        ]),
      ),
    ) as Record<Platform, PlatformReadiness>;

    let latestRevision = 0;
    for (const platform of platforms) {
      const exploratory = await startExploratoryRun({
        projectRoot,
        platform,
        payload: {
          goal: "Verify authentication",
          acceptanceCriteria: [criterion],
          readiness: readiness[platform],
        },
        now: () => startedAt,
      });
      const proof = await recordPass({
        projectRoot,
        workOrder: exploratory,
        key: `exploratory-${platform}`,
      });
      const draft = await draftCaseFromRun({
        projectRoot,
        runId: exploratory.runId,
        input: {
          caseId: "login",
          title: "Login",
          steps: [
            {
              sourceActionId: proof.interactionId,
              intent: "Authenticate",
              target: {
                description: `${platform} login control`,
                stability: "stable",
                stabilityRationale: "Fixture-owned stable control",
              },
              expectedState: criterion.description,
              assertionStrategy: "Observe authenticated home",
              evidenceCheckpoints: ["post-action-screenshot"],
            },
          ],
          excludedActions: [],
        },
      });
      latestRevision = draft.revision;
    }
    await expect(
      validateCaseRevision({
        projectRoot,
        caseId: "login",
        revision: latestRevision,
      }),
    ).resolves.toMatchObject({ valid: true, issues: [] });
    const active = await activateCaseRevision({
      projectRoot,
      caseId: "login",
      revision: latestRevision,
      reviewConfirmed: true,
      now,
    });
    expect(Object.keys(active.variants).sort()).toEqual([...platforms].sort());

    for (const platform of platforms) {
      const regression = await startRegressionRun({
        projectRoot,
        caseId: active.caseId,
        platform,
        execution: "local",
        readiness: readiness[platform],
        now: () => startedAt,
      });
      await recordPass({
        projectRoot,
        workOrder: regression,
        key: `regression-${platform}`,
      });
      expect(regression.pinnedCase?.platformVariantHash).toBeDefined();
    }

    const twoPlatform = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: [active.caseId] },
      platforms: ["ios-simulator", "android-emulator"],
      execution: "local",
      readiness,
      now: () => startedAt,
    });
    for (const member of twoPlatform.manifest.members) {
      await recordPass({
        projectRoot,
        workOrder: member.workOrder,
        key: `group-two-${member.platform}`,
      });
    }
    await finishRunGroup({
      projectRoot,
      runGroupId: twoPlatform.manifest.id,
      now,
    });
    const twoReport = await generateRunGroupReport({
      projectRoot,
      runGroupId: twoPlatform.manifest.id,
      now,
    });
    expect(twoReport.report.matrix.map((cell) => cell.platform)).toEqual([
      "ios-simulator",
      "android-emulator",
    ]);

    const cases = new CaseRepository(projectRoot);
    const limited = await cases.createDraft({
      ...active,
      caseId: "login-limited",
      title: "Login limited",
      promotion: {
        sources: {
          web: active.promotion.sources.web!,
          "ios-simulator": active.promotion.sources["ios-simulator"]!,
        },
        validationIssues: [],
      },
      variants: {
        web: active.variants.web!,
        "ios-simulator": active.variants["ios-simulator"]!,
      },
    });
    await cases.activate(limited.caseId, limited.revision, {
      confirmedBy: "user",
      confirmedAt: now().toISOString(),
    });
    const threePlatform = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: [active.caseId, limited.caseId] },
      platforms: [...platforms],
      execution: "local",
      readiness,
      now: () => startedAt,
    });
    for (const member of threePlatform.manifest.members) {
      await recordPass({
        projectRoot,
        workOrder: member.workOrder,
        key: `group-three-${member.caseId}-${member.platform}`,
      });
    }
    await finishRunGroup({
      projectRoot,
      runGroupId: threePlatform.manifest.id,
      now,
    });
    const threeReport = await generateRunGroupReport({
      projectRoot,
      runGroupId: threePlatform.manifest.id,
      now,
    });
    expect(threeReport.report.matrix).toHaveLength(6);
    expect(threeReport.report.summary).toEqual({
      pass: 5,
      fail: 0,
      blocked: 0,
      notVerified: 0,
      coverageGap: 1,
    });
    expect(threeReport.report.matrix).toContainEqual(
      expect.objectContaining({
        caseId: "login-limited",
        platform: "android-emulator",
        status: "coverage_gap",
      }),
    );
    expect(threeReport.report).not.toHaveProperty("verdict");
  }, 20_000);
});
