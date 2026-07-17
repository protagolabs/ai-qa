import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import {
  calculateCaseContentHash,
  calculateWebVariantHash,
} from "../../src/core/cases/schema.js";
import { CaseRepository } from "../../src/core/cases/repository.js";
import { sha256Canonical } from "../../src/core/canonical-json.js";
import { writeProjectConfig } from "../../src/core/config/repository.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { runReportSchema } from "../../src/core/reports/schema.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";
import {
  exportProjectLocalRunReport,
  generateRunReport,
  withVerifiedGeneratedRunReport,
} from "../../src/services/report-generation/generate-run-report.js";
import { finalizeRun } from "../../src/services/run-protocol/finalize-run.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { cancelRun } from "../../src/services/run-protocol/run-lifecycle.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { startRegressionRun } from "../../src/services/run-protocol/start-regression-run.js";
import { VerdictService } from "../../src/services/run-protocol/verdict-service.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import { initializeTestProject } from "../helpers/project-fixture.js";

const startedAt = new Date("2026-07-13T00:00:00.000Z");
const eventNow = () => new Date("2026-07-13T00:10:00.000Z");
const generatedNow = () => new Date("2026-07-13T00:20:00.000Z");

function config(
  input: {
    formats?: Array<"markdown" | "json">;
    detail?: "summary" | "full";
    recordingMode?: "local-only" | "project-skill";
  } = {},
): ProjectConfig {
  return {
    schemaVersion: 2,
    recordingPolicy: { mode: input.recordingMode ?? "local-only" },
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
      formats: input.formats ?? ["markdown", "json"],
      audience: "engineering",
      detail: input.detail ?? "full",
    },
    storagePolicy: { adapter: "project-local" },
    gitPolicy: { config: "track", artifacts: "ignore" },
    ciPolicy: { nonPassExit: "failure" },
    secretReferences: { fixtureProjectSkill: "QA_TEST_PASSWORD" },
  };
}

async function initializedProject(projectConfig: ProjectConfig) {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-report-project-"));
  await initializeTestProject({
    projectRoot,
    config: projectConfig,
  });
  return { projectRoot };
}

async function completedRun(
  options: {
    formats?: Array<"markdown" | "json">;
    detail?: "summary" | "full";
    preActionEvidenceLaundering?: boolean;
    recordingMode?: "local-only" | "project-skill";
    verdictSummary?: string;
  } = {},
) {
  const projectConfig = config(options);
  const project = await initializedProject(projectConfig);
  const projectSkillPath = ".agents/skills/ai-qa-project/SKILL.md" as const;
  const projectSkillContent = await readFile(
    join(project.projectRoot, projectSkillPath),
    "utf8",
  );
  const repository = new RunRepository(project.projectRoot, eventNow);
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
      recordingPolicy: projectConfig.recordingPolicy,
      ...(projectConfig.recordingPolicy.mode === "project-skill"
        ? {
            projectSkill: {
              path: projectSkillPath,
              contentSha256: createHash("sha256")
                .update(projectSkillContent)
                .digest("hex"),
            },
          }
        : {}),
      startedAt,
    }),
  );
  const protocol = new RunProtocolService(
    project.projectRoot,
    "run-1",
    eventNow,
  );
  const observationAction = await protocol.planAction({
    idempotencyKey: "observe-home",
    kind: "observation",
    intent: "Observe authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Current page" },
  });
  await protocol.completeAction({
    actionId: observationAction.id,
    phase: "completed",
    toolResult: {
      summary: "Observed current page",
      data: {
        arbitrary: [null, true, 3, { nested: ["safe", { value: false }] }],
      },
    },
  });
  const observation = await protocol.addObservation({
    actionId: observationAction.id,
    summary: "Authenticated home is visible",
    state: {
      url: "https://example.com/home",
      arbitrary: [null, { nested: [1, 2, 3] }],
    },
  });
  const stepId = (observationAction.payload as { stepId: string }).stepId;
  const captureAction = await protocol.planAction({
    idempotencyKey: "capture-home",
    kind: "evidence-capture",
    intent: "Capture authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Authenticated home" },
    stepId,
  });
  await protocol.completeAction({
    actionId: captureAction.id,
    phase: "completed",
    toolResult: { summary: "Screenshot captured" },
  });
  const sourcePath = join(project.projectRoot, "home.png");
  await writeFile(sourcePath, Buffer.from([1, 2, 3, 4]));
  const evidence = await registerEvidence({
    ...project,
    runId: "run-1",
    payload: {
      sourcePath,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: captureAction.id,
      idempotencyKey: "home-screenshot",
    },
    criterionIds: ["authenticated-home-visible"],
    observationIds: [observation.id],
    now: eventNow,
  });
  const interaction =
    options.preActionEvidenceLaundering === true
      ? await protocol.planAction({
          idempotencyKey: "submit-after-stale-evidence",
          kind: "interaction",
          intent: "Submit valid credentials",
          tool: "chrome-devtools-mcp",
          target: { description: "Login button" },
        })
      : undefined;
  if (interaction !== undefined) {
    await protocol.completeAction({
      actionId: interaction.id,
      phase: "completed",
      toolResult: { summary: "Credentials submitted" },
    });
  }
  const assertionStepId =
    interaction === undefined
      ? stepId
      : (interaction.payload as { stepId: string }).stepId;
  const assertion = await protocol.recordAssertion({
    criterionId: "authenticated-home-visible",
    status: "satisfied",
    assertionKinds: ["semantic-ui"],
    actual: "Authenticated home is visible",
    expected: "Authenticated home is visible",
    observationIds: [observation.id],
    evidenceIds: [evidence.id],
    stepId: assertionStepId,
  });
  await protocol.recordDecision({
    kind: "semantic",
    rationale: "The authenticated shell is the success state",
    relatedIds: [assertion.id],
  });
  const verdict = await new VerdictService(
    project.projectRoot,
    "run-1",
    eventNow,
  ).set({
    classification: "pass",
    summary: options.verdictSummary ?? "Login verified",
    criterionResults: [
      {
        criterionId: "authenticated-home-visible",
        status: "satisfied",
        assertionIds: [assertion.id],
        evidenceIds: [evidence.id],
      },
    ],
  });
  if (options.preActionEvidenceLaundering === true) {
    await repository.journal("run-1").append({
      type: "run",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "finish:run-1",
      payload: { phase: "completed", verdictId: verdict.id },
      relatedIds: [verdict.id],
    });
  } else {
    await finalizeRun({ ...project, runId: "run-1", now: eventNow });
  }
  return { ...project, evidence, repository };
}

async function appendDuplicateTypedEvidenceEvent(
  projectRoot: string,
): Promise<void> {
  const eventsPath = join(
    projectRoot,
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

describe("generateRunReport", () => {
  it("waits for the per-run report lock before replacing an artifact set", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const directory = join(
      fixture.projectRoot,
      ".ai-qa",
      "reports",
      "runs",
      "run-1",
    );
    const release = await lockfile.lock(directory, { realpath: false });
    let settled = false;
    let verificationReached!: () => void;
    const verified = new Promise<void>((resolve) => {
      verificationReached = resolve;
    });
    const generation = generateRunReport({
      ...fixture,
      runId: "run-1",
      now: () => {
        verificationReached();
        return new Date("2026-07-13T00:30:00.000Z");
      },
    }).finally(() => {
      settled = true;
    });

    try {
      await verified;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
    } finally {
      await release();
    }
    await expect(generation).resolves.toMatchObject({
      jsonPath: ".ai-qa/reports/runs/run-1/report.json",
      markdownPath: ".ai-qa/reports/runs/run-1/report.md",
    });
  });

  it("keeps concurrent generated JSON and Markdown artifacts coherent", async () => {
    const fixture = await completedRun();
    const firstTimestamp = "2026-07-13T00:30:00.000Z";
    const secondTimestamp = "2026-07-13T00:35:00.000Z";

    await Promise.all([
      generateRunReport({
        ...fixture,
        runId: "run-1",
        now: () => new Date(firstTimestamp),
      }),
      generateRunReport({
        ...fixture,
        runId: "run-1",
        now: () => new Date(secondTimestamp),
      }),
    ]);

    const directory = join(
      fixture.projectRoot,
      ".ai-qa",
      "reports",
      "runs",
      "run-1",
    );
    const json = runReportSchema.parse(
      JSON.parse(await readFile(join(directory, "report.json"), "utf8")),
    );
    const markdown = await readFile(join(directory, "report.md"), "utf8");
    expect([firstTimestamp, secondTimestamp]).toContain(
      json.integrity.verifiedAt,
    );
    expect(json.generatedAt).toBe(json.integrity.verifiedAt);
    expect(markdown).toContain(`- Generated: ${json.generatedAt}\n`);
    expect(markdown).toContain(`Verified at ${json.integrity.verifiedAt}.`);
    await expect(
      exportProjectLocalRunReport({
        ...fixture,
        runId: "run-1",
        now: () => new Date("2026-07-13T00:40:00.000Z"),
      }),
    ).resolves.toEqual({
      jsonPath: ".ai-qa/reports/runs/run-1/report.json",
      markdownPath: ".ai-qa/reports/runs/run-1/report.md",
    });
  });

  it("serializes generation and export at the per-run artifact boundary", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const directory = join(
      fixture.projectRoot,
      ".ai-qa",
      "reports",
      "runs",
      "run-1",
    );
    const release = await lockfile.lock(directory, { realpath: false });
    let generationVerificationReached!: () => void;
    const generationVerified = new Promise<void>((resolve) => {
      generationVerificationReached = resolve;
    });
    let exportVerificationReached!: () => void;
    const exportVerified = new Promise<void>((resolve) => {
      exportVerificationReached = resolve;
    });
    let generationSettled = false;
    let exportSettled = false;
    const generation = generateRunReport({
      ...fixture,
      runId: "run-1",
      now: () => {
        generationVerificationReached();
        return new Date("2026-07-13T00:30:00.000Z");
      },
    }).finally(() => {
      generationSettled = true;
    });
    const exported = exportProjectLocalRunReport({
      ...fixture,
      runId: "run-1",
      now: () => {
        exportVerificationReached();
        return new Date("2026-07-13T00:35:00.000Z");
      },
    }).finally(() => {
      exportSettled = true;
    });

    try {
      await Promise.all([generationVerified, exportVerified]);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(generationSettled).toBe(false);
      expect(exportSettled).toBe(false);
    } finally {
      await release();
    }
    await expect(Promise.all([generation, exported])).resolves.toEqual([
      expect.objectContaining({
        jsonPath: ".ai-qa/reports/runs/run-1/report.json",
        markdownPath: ".ai-qa/reports/runs/run-1/report.md",
      }),
      {
        jsonPath: ".ai-qa/reports/runs/run-1/report.json",
        markdownPath: ".ai-qa/reports/runs/run-1/report.md",
      },
    ]);
  });

  it("writes configured project-local JSON and Markdown with deterministic identity", async () => {
    const fixture = await completedRun();

    const generated = await generateRunReport({
      ...fixture,
      runId: "run-1",
      now: generatedNow,
    });

    expect(generated.jsonPath).toBe(".ai-qa/reports/runs/run-1/report.json");
    expect(generated.markdownPath).toBe(".ai-qa/reports/runs/run-1/report.md");
    const json = runReportSchema.parse(
      JSON.parse(
        await readFile(join(fixture.projectRoot, generated.jsonPath!), "utf8"),
      ),
    );
    const markdown = await readFile(
      join(fixture.projectRoot, generated.markdownPath!),
      "utf8",
    );
    expect(json.run.status).toBe("completed");
    expect(json.integrity.verifiedAt).toBe(generatedNow().toISOString());
    expect(json.verdict.classification).toBe("pass");
    expect(json.verdict.criterionResults[0]).toMatchObject({
      criterionId: "authenticated-home-visible",
      assertionIds: [expect.stringMatching(/^event-/)],
      evidenceIds: [fixture.evidence.id],
    });
    expect(json.evidence[0]).toMatchObject({
      id: fixture.evidence.id,
      path: fixture.evidence.projectRelativePath,
    });
    expect(json.timeline.map((entry) => entry.sequence)).toEqual(
      [...json.timeline.map((entry) => entry.sequence)].sort((a, b) => a - b),
    );
    expect(json.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "action",
          summary: "Action completed: Observed current page",
        }),
        expect.objectContaining({
          type: "observation",
          summary: "Authenticated home is visible",
        }),
      ]),
    );
    expect(markdown).toContain("Verdict: `pass`");
    expect(markdown).toContain("authenticated-home-visible");
    expect(markdown).toContain(fixture.evidence.id);

    const rerun = await generateRunReport({
      ...fixture,
      runId: "run-1",
      now: () => new Date("2026-07-13T00:25:00.000Z"),
    });
    const rerunJson = runReportSchema.parse(
      JSON.parse(
        await readFile(join(fixture.projectRoot, rerun.jsonPath!), "utf8"),
      ),
    );
    const {
      generatedAt: firstGeneratedAt,
      integrity: { verifiedAt: firstVerifiedAt, ...firstIntegrity },
      ...firstRest
    } = json;
    const {
      generatedAt: secondGeneratedAt,
      integrity: { verifiedAt: secondVerifiedAt, ...secondIntegrity },
      ...secondRest
    } = rerunJson;
    expect(firstGeneratedAt).not.toBe(secondGeneratedAt);
    expect(firstVerifiedAt).not.toBe(secondVerifiedAt);
    expect({ ...secondRest, integrity: secondIntegrity }).toEqual({
      ...firstRest,
      integrity: firstIntegrity,
    });
  });

  it("filters summary timelines to lifecycle, blocker, verdict, assertion, and evidence events", async () => {
    const fixture = await completedRun({
      formats: ["json"],
      detail: "summary",
    });

    const generated = await generateRunReport({
      ...fixture,
      runId: "run-1",
      now: generatedNow,
    });

    expect(generated.markdownPath).toBeUndefined();
    await expect(
      readFile(
        join(fixture.projectRoot, ".ai-qa/reports/runs/run-1/report.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(generated.report.timeline.map((event) => event.type)).toEqual([
      "run",
      "evidence",
      "assertion",
      "verdict",
      "run",
    ]);
  });

  it("supports cancelled reports without leaving the advertised terminal action dead", async () => {
    const project = await initializedProject(config());
    const repository = new RunRepository(project.projectRoot, eventNow);
    await repository.create(
      createExploratoryWorkOrder({
        projectId: "sample-web",
        runId: "run-1",
        input: exploratoryRunInputSchema.parse({
          goal: "Explore the login flow",
          acceptanceCriteria: [
            {
              id: "login-flow-reviewed",
              description: "Login flow is reviewed",
              requiredEvidence: ["screenshot"],
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
    const verdicts = new VerdictService(
      project.projectRoot,
      "run-1",
      eventNow,
    );
    await expect(
      verdicts.set({
        classification: "not_verified",
        reasonCode: "cancelled",
        summary: "Forged cancellation",
        criterionResults: [
          {
            criterionId: "login-flow-reviewed",
            status: "satisfied",
            assertionIds: ["event-forged"],
            evidenceIds: ["evidence-forged"],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "verdict.cancel_requires_lifecycle" });
    await cancelRun({
      ...project,
      runId: "run-1",
      reason: "User stopped exploratory QA",
      now: eventNow,
    });

    const generated = await generateRunReport({
      ...project,
      runId: "run-1",
      now: generatedNow,
    });

    expect(generated.report.run.status).toBe("cancelled");
    expect(generated.report.verdict).toMatchObject({
      classification: "not_verified",
      reasonCode: "cancelled",
      summary: "User stopped exploratory QA",
    });
    expect(generated.report.verdict.criterionResults).toEqual([]);
  });

  it("rejects a historical cancellation verdict with criterion citations", async () => {
    const project = await initializedProject(config());
    const repository = new RunRepository(project.projectRoot, eventNow);
    await repository.create(
      createExploratoryWorkOrder({
        projectId: "sample-web",
        runId: "run-1",
        input: exploratoryRunInputSchema.parse({
          goal: "Explore the login flow",
          acceptanceCriteria: [
            {
              id: "login-flow-reviewed",
              description: "Login flow is reviewed",
              requiredEvidence: ["screenshot"],
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
    const payload = {
      classification: "not_verified" as const,
      reasonCode: "cancelled" as const,
      summary: "Forged historical cancellation",
      criterionResults: [
        {
          criterionId: "login-flow-reviewed",
          status: "satisfied" as const,
          assertionIds: ["event-forged"],
          evidenceIds: ["evidence-forged"],
        },
      ],
    };
    await repository.journal("run-1").append({
      type: "verdict",
      actor: "agent",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: `verdict:${sha256Canonical(payload)}`,
      payload,
      relatedIds: ["event-forged", "evidence-forged"],
    });

    await expect(
      generateRunReport({ ...project, runId: "run-1", now: generatedNow }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
  });

  it("refuses raw evidence tampering before creating report output", async () => {
    const fixture = await completedRun();
    await writeFile(
      join(fixture.projectRoot, fixture.evidence.projectRelativePath),
      Buffer.from([9, 9, 9]),
    );

    await expect(
      generateRunReport({ ...fixture, runId: "run-1", now: generatedNow }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
    await expect(
      readFile(
        join(fixture.projectRoot, ".ai-qa/reports/runs/run-1/report.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked report ancestor instead of writing outside the project", async () => {
    const fixture = await completedRun();
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-report-outside-"));
    const reports = join(fixture.projectRoot, ".ai-qa/reports");
    await rename(reports, join(outside, "original-reports"));
    await symlink(outside, reports, "dir");

    await expect(
      generateRunReport({ ...fixture, runId: "run-1", now: generatedNow }),
    ).rejects.toMatchObject({ code: "report.storage_integrity_error" });
    await expect(
      readFile(join(outside, "runs/run-1/report.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects regeneration over a symlinked report.json artifact", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const directory = join(fixture.projectRoot, ".ai-qa/reports/runs/run-1");
    const jsonPath = join(directory, "report.json");
    const markdownPath = join(directory, "report.md");
    const outside = join(
      await mkdtemp(join(tmpdir(), "ai-qa-generation-json-outside-")),
      "report.json",
    );
    const beforeMarkdown = await readFile(markdownPath, "utf8");
    await rename(jsonPath, outside);
    await symlink(outside, jsonPath, "file");

    await expect(
      generateRunReport({
        ...fixture,
        runId: "run-1",
        now: () => new Date("2026-07-13T00:30:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "report.storage_integrity_error" });
    expect((await lstat(jsonPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(markdownPath, "utf8")).toBe(beforeMarkdown);
  });

  it("rejects regeneration over a symlinked report.md artifact", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const directory = join(fixture.projectRoot, ".ai-qa/reports/runs/run-1");
    const jsonPath = join(directory, "report.json");
    const markdownPath = join(directory, "report.md");
    const outside = join(
      await mkdtemp(join(tmpdir(), "ai-qa-generation-markdown-outside-")),
      "report.md",
    );
    const beforeJson = await readFile(jsonPath, "utf8");
    await rename(markdownPath, outside);
    await symlink(outside, markdownPath, "file");

    await expect(
      generateRunReport({
        ...fixture,
        runId: "run-1",
        now: () => new Date("2026-07-13T00:30:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "report.storage_integrity_error" });
    expect((await lstat(markdownPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(jsonPath, "utf8")).toBe(beforeJson);
  });

  it("rejects regeneration over a non-regular configured artifact", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const directory = join(fixture.projectRoot, ".ai-qa/reports/runs/run-1");
    const jsonPath = join(directory, "report.json");
    const markdownPath = join(directory, "report.md");
    const beforeMarkdown = await readFile(markdownPath, "utf8");
    await rename(jsonPath, `${jsonPath}.original`);
    await mkdir(jsonPath);

    await expect(
      generateRunReport({
        ...fixture,
        runId: "run-1",
        now: () => new Date("2026-07-13T00:30:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "report.storage_integrity_error" });
    expect((await lstat(jsonPath)).isDirectory()).toBe(true);
    expect(await readFile(markdownPath, "utf8")).toBe(beforeMarkdown);
  });

  it("rejects duplicate evidence index records instead of collapsing their IDs", async () => {
    const fixture = await completedRun();
    const indexPath = join(
      fixture.projectRoot,
      ".ai-qa/evidence/run-1/index.jsonl",
    );
    await appendFile(indexPath, await readFile(indexPath, "utf8"));

    await expect(
      generateRunReport({ ...fixture, runId: "run-1", now: generatedNow }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });

  it("classifies duplicate typed evidence before report generation", async () => {
    const fixture = await completedRun();
    await appendDuplicateTypedEvidenceEvent(fixture.projectRoot);

    await expect(
      generateRunReport({ ...fixture, runId: "run-1", now: generatedNow }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });

  it("rejects a typed event forged after the terminal lifecycle event", async () => {
    const fixture = await completedRun();
    const payload = {
      kind: "semantic" as const,
      rationale: "This event was forged after completion",
      relatedIds: [],
    };
    await fixture.repository.journal("run-1").append({
      type: "decision",
      actor: "agent",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: `decision:${sha256Canonical(payload)}`,
      payload,
      relatedIds: [],
    });

    await expect(
      generateRunReport({ ...fixture, runId: "run-1", now: generatedNow }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
  });

  it("reapplies finalization support gates before reporting a forged pass", async () => {
    const project = await initializedProject(config());
    const repository = new RunRepository(project.projectRoot, eventNow);
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
    const verdict = await new VerdictService(
      project.projectRoot,
      "run-1",
      eventNow,
    ).set({
      classification: "pass",
      summary: "Forged unsupported pass",
      criterionResults: [],
    });
    await new RunRepository(
      project.projectRoot,
      () => new Date("2026-07-13T00:31:00.000Z"),
    )
      .journal("run-1")
      .append({
        type: "run",
        actor: "ai-qa",
        platform: "web",
        tool: "ai-qa",
        idempotencyKey: "finish:run-1",
        payload: { phase: "completed", verdictId: verdict.id },
        relatedIds: [verdict.id],
      });

    await expect(
      generateRunReport({ ...project, runId: "run-1", now: generatedNow }),
    ).rejects.toMatchObject({ code: "run.action_required" });
  });

  it("rejects completed history with pre-action evidence before writing reports", async () => {
    const project = await completedRun({
      preActionEvidenceLaundering: true,
    });

    await expect(
      exportProjectLocalRunReport({
        ...project,
        runId: "run-1",
        now: generatedNow,
      }),
    ).rejects.toMatchObject({
      code: "verdict.stale_post_action_evidence",
    });
    await expect(
      generateRunReport({ ...project, runId: "run-1", now: generatedNow }),
    ).rejects.toMatchObject({
      code: "verdict.stale_post_action_evidence",
    });
    await expect(
      access(join(project.projectRoot, ".ai-qa", "reports", "runs", "run-1")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reapplies the pass deadline gate to the terminal event timestamp", async () => {
    const fixture = await completedRun();
    const eventsPath = join(
      fixture.projectRoot,
      ".ai-qa/runs/run-1/events.jsonl",
    );
    const events = (await readFile(eventsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    events.at(-1)!.timestamp = "2026-07-13T00:31:00.000Z";
    await writeFile(
      eventsPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await expect(
      generateRunReport({ ...fixture, runId: "run-1", now: generatedNow }),
    ).rejects.toMatchObject({ code: "run.deadline_exceeded" });
  });

  it("revalidates pinned regression case and Web variant hashes before writing", async () => {
    const project = await initializedProject(config());
    const cases = new CaseRepository(project.projectRoot, eventNow);
    const draft = await cases.createDraft({
      schemaVersion: 1,
      caseId: "login-success",
      title: "Verify successful login",
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
              id: "step-login",
              sourceActionId: "event-source-action",
              intent: "Submit valid credentials",
              tool: "chrome-devtools-mcp",
              target: {
                description: "Login form",
                selector: "[data-testid=login-form]",
                stability: "stable",
                stabilityRationale: "Uses a test ID",
              },
              expectedState: "Authenticated home is visible",
              assertionStrategy: "Observe the authenticated shell",
              evidenceCheckpoints: ["post-action-screenshot"],
            },
          ],
        },
      },
    });
    expect(draft.contentHash).toBe(calculateCaseContentHash(draft));
    expect(calculateWebVariantHash(draft)).toMatch(/^sha256:/);
    await cases.activate("login-success", draft.revision, {
      confirmedBy: "user",
      confirmedAt: eventNow().toISOString(),
    });
    const workOrder = await startRegressionRun({
      ...project,
      caseId: "login-success",
      execution: "local",
      readiness: { platform: "web", status: "ready", checks: [] },
      now: eventNow,
    });
    await cancelRun({
      ...project,
      runId: workOrder.runId,
      reason: "Stop the regression replay",
      now: eventNow,
    });
    const revisionPath = join(
      project.projectRoot,
      ".ai-qa/cases/login-success/revisions/1.yaml",
    );
    await writeFile(
      revisionPath,
      (await readFile(revisionPath, "utf8")).replace(
        "Verify successful login",
        "Tampered regression title",
      ),
    );

    await expect(
      generateRunReport({
        ...project,
        runId: workOrder.runId,
        now: generatedNow,
      }),
    ).rejects.toMatchObject({ code: "case.content_hash_mismatch" });
    await expect(
      readFile(
        join(
          project.projectRoot,
          `.ai-qa/reports/runs/${workOrder.runId}/report.json`,
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("report CLI and project-local export", () => {
  it("preserves the missing-report domain error before lock acquisition", async () => {
    const fixture = await completedRun();

    await expect(
      exportProjectLocalRunReport({
        ...fixture,
        runId: "run-1",
        now: generatedNow,
      }),
    ).rejects.toMatchObject({ code: "report.not_generated" });
  });

  it("generates and exports only project-relative configured paths", async () => {
    const fixture = await completedRun();
    const captured = createCapturedCli({
      cwd: fixture.projectRoot,
      now: generatedNow,
    });

    expect(
      await runCli(
        ["--project", fixture.projectRoot, "report", "generate", "run-1"],
        captured.context,
      ),
    ).toBe(0);
    const generated = JSON.parse(captured.stdout.pop()!) as {
      jsonPath: string;
      markdownPath: string;
    };
    expect(generated).toEqual({
      jsonPath: ".ai-qa/reports/runs/run-1/report.json",
      markdownPath: ".ai-qa/reports/runs/run-1/report.md",
    });
    expect(
      await runCli(
        [
          "report",
          "export",
          "run-1",
          "--project",
          fixture.projectRoot,
          "--adapter",
          "project-local",
        ],
        captured.context,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.pop()!)).toEqual(generated);
    expect(captured.stderr).toEqual([]);
  });

  it("rejects unsupported adapters without generating or mutating run state", async () => {
    const fixture = await completedRun();
    const beforeEvents = await readFile(
      join(fixture.projectRoot, ".ai-qa/runs/run-1/events.jsonl"),
      "utf8",
    );
    const captured = createCapturedCli({
      cwd: fixture.projectRoot,
      now: generatedNow,
    });

    expect(
      await runCli(
        ["report", "export", "run-1", "--adapter", "remote-warehouse"],
        captured.context,
      ),
    ).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: { code: "adapter.unsupported_in_increment_1" },
    });
    expect(
      await readFile(
        join(fixture.projectRoot, ".ai-qa/runs/run-1/events.jsonl"),
        "utf8",
      ),
    ).toBe(beforeEvents);
    await expect(
      readFile(
        join(fixture.projectRoot, ".ai-qa/reports/runs/run-1/report.json"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-verifies integrity before returning an existing export", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const reportPath = join(
      fixture.projectRoot,
      ".ai-qa/reports/runs/run-1/report.json",
    );
    const beforeReport = await readFile(reportPath, "utf8");
    await writeFile(
      join(fixture.projectRoot, fixture.evidence.projectRelativePath),
      Buffer.from([7, 7, 7]),
    );

    await expect(
      exportProjectLocalRunReport({
        ...fixture,
        runId: "run-1",
        now: generatedNow,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
    expect(await readFile(reportPath, "utf8")).toBe(beforeReport);
  });

  it("rejects duplicate evidence index records before export", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
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
      exportProjectLocalRunReport({
        ...fixture,
        runId: "run-1",
        now: generatedNow,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
  });

  it("rejects export through a symlinked report ancestor", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-export-outside-"));
    const reports = join(fixture.projectRoot, ".ai-qa/reports");
    const relocated = join(outside, "reports");
    await mkdir(outside, { recursive: true });
    await rename(reports, relocated);
    await symlink(relocated, reports, "dir");

    await expect(
      exportProjectLocalRunReport({
        ...fixture,
        runId: "run-1",
        now: generatedNow,
      }),
    ).rejects.toMatchObject({ code: "report.storage_integrity_error" });
  });

  it("rejects export through a symlinked report artifact", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const outside = join(
      await mkdtemp(join(tmpdir(), "ai-qa-export-artifact-outside-")),
      "report.json",
    );
    const path = join(
      fixture.projectRoot,
      ".ai-qa/reports/runs/run-1/report.json",
    );
    await rename(path, outside);
    await symlink(outside, path, "file");

    await expect(
      exportProjectLocalRunReport({
        ...fixture,
        runId: "run-1",
        now: generatedNow,
      }),
    ).rejects.toMatchObject({ code: "report.storage_integrity_error" });
  });

  it("rejects a schema-valid modified report JSON artifact", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const path = join(
      fixture.projectRoot,
      ".ai-qa/reports/runs/run-1/report.json",
    );
    const report = JSON.parse(await readFile(path, "utf8")) as {
      verdict: { summary: string };
    };
    report.verdict.summary = "Schema-valid but modified summary";
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);

    await expect(
      exportProjectLocalRunReport({
        ...fixture,
        runId: "run-1",
        now: generatedNow,
      }),
    ).rejects.toMatchObject({ code: "report.integrity_error" });
  });

  it("rejects a modified report Markdown artifact", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const path = join(
      fixture.projectRoot,
      ".ai-qa/reports/runs/run-1/report.md",
    );
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        "Login verified",
        "Modified report summary",
      ),
    );

    await expect(
      exportProjectLocalRunReport({
        ...fixture,
        runId: "run-1",
        now: generatedNow,
      }),
    ).rejects.toMatchObject({ code: "report.integrity_error" });
  });

  it("exports untouched Markdown-only output with user-authored timestamp-like text", async () => {
    const fixture = await completedRun({
      formats: ["markdown"],
      verdictSummary:
        "Login verified\n- Generated: 2020-01-01T00:00:00.000Z\n## Goal\nAdditional context\nVerified at 2020-01-01T00:00:00.000Z.",
    });
    const generated = await generateRunReport({
      ...fixture,
      runId: "run-1",
      now: generatedNow,
    });

    await expect(
      exportProjectLocalRunReport({
        ...fixture,
        runId: "run-1",
        now: () => new Date("2026-07-13T00:25:00.000Z"),
      }),
    ).resolves.toEqual({ markdownPath: generated.markdownPath });
  });
});

describe("verified generated report boundary", () => {
  it("invokes the callback only after configured report bytes match terminal state", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const jsonPath = join(
      fixture.projectRoot,
      ".ai-qa/reports/runs/run-1/report.json",
    );
    const report = JSON.parse(await readFile(jsonPath, "utf8")) as {
      verdict: { summary: string };
    };
    report.verdict.summary = "Modified before verified callback";
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    let called = false;

    await expect(
      withVerifiedGeneratedRunReport(
        { ...fixture, runId: "run-1", now: generatedNow },
        () => {
          called = true;
          return Promise.resolve();
        },
      ),
    ).rejects.toMatchObject({ code: "report.integrity_error" });
    expect(called).toBe(false);
  });

  it("exposes the frozen Project Skill snapshot only after report integrity succeeds inside the lock", async () => {
    const fixture = await completedRun({ recordingMode: "project-skill" });
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const projectSkillPath = ".agents/skills/ai-qa-project/SKILL.md" as const;
    const projectSkillContent = await readFile(
      join(fixture.projectRoot, projectSkillPath),
      "utf8",
    );

    await expect(
      withVerifiedGeneratedRunReport(
        { ...fixture, runId: "run-1", now: generatedNow },
        async (verified) => {
          await expect(
            lockfile.lock(verified.directory, {
              realpath: false,
              retries: 0,
            }),
          ).rejects.toMatchObject({ code: "ELOCKED" });
          return verified.projectSkill;
        },
      ),
    ).resolves.toEqual({
      path: projectSkillPath,
      contentSha256: createHash("sha256")
        .update(projectSkillContent)
        .digest("hex"),
    });
  });

  it("holds the lock while exposing canonical storage, current config, and snapshotted recording mode without rewriting bytes", async () => {
    const fixture = await completedRun();
    await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
    const directory = join(
      fixture.projectRoot,
      ".ai-qa",
      "reports",
      "runs",
      "run-1",
    );
    const jsonPath = join(directory, "report.json");
    const markdownPath = join(directory, "report.md");
    const beforeJson = await readFile(jsonPath, "utf8");
    const beforeMarkdown = await readFile(markdownPath, "utf8");
    await writeProjectConfig(fixture.projectRoot, {
      ...config(),
      recordingPolicy: { mode: "project-skill" },
    });

    const result = await withVerifiedGeneratedRunReport(
      { ...fixture, runId: "run-1", now: generatedNow },
      async (verified) => {
        await expect(
          lockfile.lock(verified.directory, {
            realpath: false,
            retries: 0,
          }),
        ).rejects.toMatchObject({ code: "ELOCKED" });
        expect(verified.projectRoot).toBe(await realpath(fixture.projectRoot));
        expect(verified.directory).toBe(await realpath(directory));
        expect(verified.config.recordingPolicy.mode).toBe("project-skill");
        expect(verified.recordingMode).toBe("local-only");
        expect(verified.projectSkill).toBeUndefined();
        expect(verified.report.run.id).toBe("run-1");
        expect(verified.paths).toEqual({
          jsonPath: ".ai-qa/reports/runs/run-1/report.json",
          markdownPath: ".ai-qa/reports/runs/run-1/report.md",
        });
        expect(await readFile(jsonPath, "utf8")).toBe(beforeJson);
        expect(await readFile(markdownPath, "utf8")).toBe(beforeMarkdown);
        return "verified";
      },
    );

    expect(result).toBe("verified");
    expect(await readFile(jsonPath, "utf8")).toBe(beforeJson);
    expect(await readFile(markdownPath, "utf8")).toBe(beforeMarkdown);
  });
});
