import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { CaseRepository } from "../../src/core/cases/repository.js";
import { AiQaError } from "../../src/core/errors.js";
import { RunJournal } from "../../src/core/runs/journal.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { writeProjectConfig } from "../../src/core/config/repository.js";
import { createPreflightResultRun } from "../../src/services/run-protocol/create-preflight-result-run.js";
import { startExploratoryRun } from "../../src/services/run-protocol/start-exploratory-run.js";
import { startRegressionRun } from "../../src/services/run-protocol/start-regression-run.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import { installStaleGlobalSkill } from "../helpers/global-skill-fixture.js";
import {
  initializeTestProject,
  projectConfig,
  projectSkillSource,
} from "../helpers/project-fixture.js";

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

const readyPayload = exploratoryRunInputSchema.parse({
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
    status: "ready",
    checks: [
      {
        code: "runtime.node",
        status: "pass",
        message: "Node runtime is supported",
        category: "installation",
      },
      {
        code: "project.config",
        status: "pass",
        message: "Configuration .ai-qa/config.yaml is readable",
        category: "installation",
      },
      {
        code: "agent.project_skill",
        status: "pass",
        message: "Project Skill is a regular file",
        category: "installation",
      },
      {
        code: "project.storage",
        status: "pass",
        message: "Canonical project storage is writable",
        category: "installation",
      },
    ],
  },
});

const projectSkillRelativePath =
  ".agents/skills/ai-qa-project/SKILL.md" as const;

function expectedProjectSkillSnapshot() {
  return {
    path: projectSkillRelativePath,
    contentSha256: createHash("sha256")
      .update(projectSkillSource())
      .digest("hex"),
  };
}

async function installProjectSkillSource(projectRoot: string): Promise<void> {
  await writeFile(
    join(projectRoot, projectSkillRelativePath),
    projectSkillSource(),
    "utf8",
  );
}

async function createActiveRegressionCase(
  projectRoot: string,
  now: () => Date,
): Promise<void> {
  const cases = new CaseRepository(projectRoot, now);
  const revision = await cases.createDraft({
    schemaVersion: 2,
    caseId: "login-success",
    title: "Successful login",
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
            id: "step-submit-login",
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
            evidenceCheckpoints: ["post-action-screenshot"],
          },
        ],
      },
    },
  });
  await cases.activate("login-success", revision.revision, {
    confirmedBy: "user",
    confirmedAt: now().toISOString(),
  });
}

describe("RunJournal", () => {
  it("anchors events to the immutable work-order platform", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-ios-journal-"));
    const repository = new RunRepository(
      projectRoot,
      () => new Date("2026-07-13T00:00:00.000Z"),
    );
    const workOrder = createExploratoryWorkOrder({
      platform: "ios-simulator",
      projectId: "sample-project",
      runId: "run-ios",
      input: exploratoryRunInputSchema.parse({
        goal: "Verify the iOS home screen",
        acceptanceCriteria: [
          {
            id: "home-visible",
            description: "Home is visible",
            requiredEvidence: ["screenshot"],
          },
        ],
        readiness: {
          platform: "ios-simulator",
          status: "ready",
          checks: [],
        },
      }),
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      startedAt: new Date("2026-07-13T00:00:00.000Z"),
    });
    const { journal } = await repository.create(workOrder);
    await expect(journal.readAll()).resolves.toMatchObject([
      { sequence: 1, platform: "ios-simulator" },
    ]);

    await expect(
      journal.append({
        type: "decision",
        actor: "agent",
        platform: "web",
        tool: "ai-qa",
        payload: {
          kind: "semantic",
          rationale: "Forged platform",
          relatedIds: [],
        },
        relatedIds: [],
      }),
    ).rejects.toMatchObject({ code: "journal.integrity_error" });
  });

  it("maps a missing journal to run.not_found before a locked read", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-"));
    const journal = RunJournal.open(
      projectRoot,
      "run-missing",
      () => new Date("2026-07-13T00:00:00.000Z"),
    );

    await expect(journal.readLocked(() => undefined)).rejects.toMatchObject({
      code: "run.not_found",
      message: "Run does not exist",
      details: { runId: "run-missing" },
    });
  });

  it("maps a missing journal to run.not_found before an append", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-"));
    const journal = RunJournal.open(
      projectRoot,
      "run-missing",
      () => new Date("2026-07-13T00:00:00.000Z"),
    );

    await expect(
      journal.append({
        type: "decision",
        actor: "ai-qa",
        platform: "web",
        tool: "ai-qa",
        payload: {
          kind: "semantic",
          rationale: "Missing journal",
          relatedIds: [],
        },
        relatedIds: [],
      }),
    ).rejects.toMatchObject({
      code: "run.not_found",
      message: "Run does not exist",
      details: { runId: "run-missing" },
    });
  });

  it("preserves non-missing storage integrity failures before locked reads", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-"));
    const journal = await RunJournal.create(
      projectRoot,
      "run-1",
      () => new Date("2026-07-13T00:00:00.000Z"),
    );
    const eventsPath = join(
      projectRoot,
      ".ai-qa",
      "runs",
      "run-1",
      "events.jsonl",
    );
    await rm(eventsPath);
    await mkdir(eventsPath);

    await expect(journal.readLocked(() => undefined)).rejects.toMatchObject({
      code: "storage.integrity_error",
    });
  });

  it("preserves non-missing storage integrity failures before appends", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-"));
    const journal = await RunJournal.create(
      projectRoot,
      "run-1",
      () => new Date("2026-07-13T00:00:00.000Z"),
    );
    const eventsPath = join(
      projectRoot,
      ".ai-qa",
      "runs",
      "run-1",
      "events.jsonl",
    );
    await rm(eventsPath);
    await mkdir(eventsPath);

    await expect(
      journal.append({
        type: "decision",
        actor: "ai-qa",
        platform: "web",
        tool: "ai-qa",
        payload: {
          kind: "semantic",
          rationale: "Invalid journal storage",
          relatedIds: [],
        },
        relatedIds: [],
      }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
  });

  it("preserves the cause when journal parsing fails", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-"));
    const journal = await RunJournal.create(
      projectRoot,
      "run-1",
      () => new Date("2026-07-13T00:00:00.000Z"),
    );
    const eventsPath = join(
      projectRoot,
      ".ai-qa",
      "runs",
      "run-1",
      "events.jsonl",
    );
    await writeFile(eventsPath, "not json\n", "utf8");

    const error = await journal.readAll().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AiQaError);
    expect((error as AiQaError).code).toBe("journal.integrity_error");
    const anyString: unknown = expect.any(String);
    expect((error as AiQaError).details.cause).toEqual({
      code: anyString,
      message: anyString,
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "surfaces filesystem failures as filesystem.operation_failed",
    async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-"));
      const journal = await RunJournal.create(
        projectRoot,
        "run-1",
        () => new Date("2026-07-13T00:00:00.000Z"),
      );
      const eventsPath = join(
        projectRoot,
        ".ai-qa",
        "runs",
        "run-1",
        "events.jsonl",
      );
      await chmod(eventsPath, 0o000);
      try {
        const error = await journal
          .readAll()
          .catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(AiQaError);
        expect((error as AiQaError).code).toBe("filesystem.operation_failed");
      } finally {
        await chmod(eventsPath, 0o600);
      }
    },
  );

  it("persists newline-terminated replacements across journal instances", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-"));
    const now = () => new Date("2026-07-13T00:00:00.000Z");
    const journal = await RunJournal.create(projectRoot, "run-1", now);
    await journal.append({
      type: "run",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "start-run-1",
      payload: { phase: "started", workOrderHash: "sha256:existing" },
      relatedIds: [],
    });
    await journal.append({
      type: "decision",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "decision-run-1",
      payload: {
        kind: "semantic",
        rationale: "Persist both events",
        relatedIds: [],
      },
      relatedIds: [],
    });
    const path = join(projectRoot, ".ai-qa", "runs", "run-1", "events.jsonl");
    const reopened = RunJournal.open(projectRoot, "run-1", now);

    expect(await readFile(path, "utf8")).toMatch(/[^\n]\n$/u);
    await expect(reopened.readAll()).resolves.toHaveLength(2);
  });

  it("serializes sequence numbers and makes idempotent retries stable", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-"));
    const journal = await RunJournal.create(
      projectRoot,
      "run-1",
      () => new Date("2026-07-13T00:00:00.000Z"),
    );
    const eventInput = {
      type: "run" as const,
      actor: "ai-qa" as const,
      platform: "web" as const,
      tool: "ai-qa",
      idempotencyKey: "start-run-1",
      payload: {
        phase: "started" as const,
        workOrderHash: "sha256:stable",
      },
      relatedIds: [],
    };

    const first = await journal.append(eventInput);
    const retry = await journal.append(eventInput);

    expect(first.sequence).toBe(1);
    expect(retry.id).toBe(first.id);
    expect(await journal.readAll()).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key with different canonical input", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-"));
    const journal = await RunJournal.create(
      projectRoot,
      "run-1",
      () => new Date("2026-07-13T00:00:00.000Z"),
    );
    await journal.append({
      type: "decision",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "start-run-1",
      payload: {
        kind: "semantic",
        rationale: "First input",
        relatedIds: [],
      },
      relatedIds: [],
    });

    await expect(
      journal.append({
        relatedIds: [],
        payload: {
          kind: "semantic",
          rationale: "Different input",
          relatedIds: [],
        },
        idempotencyKey: "start-run-1",
        tool: "ai-qa",
        platform: "web",
        actor: "ai-qa",
        type: "decision",
      }),
    ).rejects.toMatchObject({ code: "event.idempotency_conflict" });
  });

  it("holds the journal lock across prepared work and its append", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-"));
    const journal = await RunJournal.create(
      projectRoot,
      "run-1",
      () => new Date("2026-07-13T00:00:00.000Z"),
    );
    let enterPrepare: () => void = () => undefined;
    const prepareEntered = new Promise<void>((resolve) => {
      enterPrepare = resolve;
    });
    let releasePrepare: () => void = () => undefined;
    const prepareReleased = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const coordinated = journal.appendPrepared(async () => {
      enterPrepare();
      await prepareReleased;
      return {
        input: {
          type: "decision" as const,
          actor: "ai-qa" as const,
          platform: "web" as const,
          tool: "ai-qa",
          idempotencyKey: "coordinated-key",
          payload: {
            kind: "semantic",
            rationale: "Prepared",
            relatedIds: [],
          },
          relatedIds: [],
        },
        resolve: (event: { id: string }) => event.id,
      };
    });
    await prepareEntered;
    let competitorSettled = false;
    const competitor = journal
      .append({
        type: "decision",
        actor: "ai-qa",
        platform: "web",
        tool: "ai-qa",
        idempotencyKey: "coordinated-key",
        payload: {
          kind: "semantic",
          rationale: "Competitor",
          relatedIds: [],
        },
        relatedIds: [],
      })
      .then(
        (event) => event,
        (error: unknown) => error,
      )
      .finally(() => {
        competitorSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(competitorSettled).toBe(false);
    releasePrepare();
    await expect(coordinated).resolves.toMatch(/^event-/);
    expect(await competitor).toMatchObject({
      code: "event.idempotency_conflict",
    });
    expect(await journal.readAll()).toHaveLength(1);
  });
});

describe("RunRepository", () => {
  it("creates work orders exclusively and detects later tampering", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-repository-"));
    const workOrder = createExploratoryWorkOrder({
      platform: "web",
      projectId: "sample-web",
      runId: "run-1",
      input: readyPayload,
      evidencePolicy: {
        screenshots: "required",
        defaultSensitivity: "internal",
      },
      startedAt: new Date("2026-07-13T00:00:00.000Z"),
    });
    const repository = new RunRepository(
      projectRoot,
      () => new Date("2026-07-13T00:00:00.000Z"),
    );

    await repository.create(workOrder);
    await expect(repository.readVerifiedWorkOrder("run-1")).resolves.toEqual(
      workOrder,
    );
    await expect(repository.create(workOrder)).rejects.toMatchObject({
      code: "run.already_exists",
    });

    const path = join(
      projectRoot,
      ".ai-qa",
      "runs",
      "run-1",
      "work-order.json",
    );
    const tampered = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    tampered.goal = "Tampered goal";
    await writeFile(path, JSON.stringify(tampered));
    await expect(
      repository.readVerifiedWorkOrder("run-1"),
    ).rejects.toMatchObject({ code: "work_order.integrity_error" });
  });
});

describe("exploratory run start", () => {
  it("requires supplied ready doctor status before creating a run", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-start-"));
    await initializeTestProject({ projectRoot, config });

    await expect(
      startExploratoryRun({
        projectRoot,
        platform: "web",
        payload: {
          ...readyPayload,
          readiness: { ...readyPayload.readiness, status: "not_ready" },
        },
        now: () => new Date("2026-07-13T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "doctor.not_ready" });
  });

  it("freezes the Project Skill bytes in exploratory work orders", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-start-"));
    await initializeTestProject({
      projectRoot,
      config: { ...config, recordingPolicy: { mode: "project-skill" } },
    });
    await installProjectSkillSource(projectRoot);

    const workOrder = await startExploratoryRun({
      projectRoot,
      platform: "web",
      payload: readyPayload,
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    });

    expect(workOrder.projectSkill).toEqual(expectedProjectSkillSnapshot());
  });

  it("freezes the Project Skill bytes in regression work orders", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-start-"));
    const now = () => new Date("2026-07-13T00:00:00.000Z");
    await initializeTestProject({
      projectRoot,
      config: { ...config, recordingPolicy: { mode: "project-skill" } },
    });
    await installProjectSkillSource(projectRoot);
    await createActiveRegressionCase(projectRoot, now);

    const workOrder = await startRegressionRun({
      projectRoot,
      caseId: "login-success",
      platform: "web",
      execution: "local",
      readiness: { platform: "web", status: "ready", checks: [] },
      now,
    });

    expect(workOrder.projectSkill).toEqual(expectedProjectSkillSnapshot());
  });

  it("rejects a configured platform missing from the active case", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-start-"));
    const now = () => new Date("2026-07-13T00:00:00.000Z");
    await initializeTestProject({
      projectRoot,
      config: projectConfig(["ios-simulator"]),
    });
    await createActiveRegressionCase(projectRoot, now);

    await expect(
      startRegressionRun({
        projectRoot,
        caseId: "login-success",
        platform: "ios-simulator",
        execution: "local",
        readiness: {
          platform: "ios-simulator",
          status: "ready",
          checks: [],
        },
        now,
      }),
    ).rejects.toMatchObject({
      code: "case.variant_missing",
      details: { platform: "ios-simulator", caseId: "login-success" },
    });
  });

  it("freezes the Project Skill bytes in not-ready preflight work orders", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-start-"));
    const now = () => new Date("2026-07-13T00:00:00.000Z");
    const readiness = {
      platform: "web" as const,
      status: "not_ready" as const,
      checks: [
        {
          code: "web.chrome_devtools_mcp" as const,
          status: "fail" as const,
          message: "Global skill status: stale",
          category: "tool" as const,
        },
      ],
    };
    await initializeTestProject({
      projectRoot,
      config: { ...config, recordingPolicy: { mode: "project-skill" } },
    });
    await installProjectSkillSource(projectRoot);

    const result = await createPreflightResultRun({
      projectRoot,
      kind: "exploratory",
      exploratoryPayload: { ...readyPayload, readiness },
      execution: "local",
      readiness,
      now,
    });
    const workOrder = await new RunRepository(
      projectRoot,
      now,
    ).readVerifiedWorkOrder(result.runId);

    expect(workOrder.projectSkill).toEqual(expectedProjectSkillSnapshot());
  });

  it("blocks project-skill preflight before run creation when the target Skill is missing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-start-"));
    const now = () => new Date("2026-07-13T00:00:00.000Z");
    const readiness = {
      platform: "web" as const,
      status: "not_ready" as const,
      checks: [
        {
          code: "web.chrome_devtools_mcp" as const,
          status: "fail" as const,
          message: "Global skill status: stale",
          category: "tool" as const,
        },
      ],
    };
    await initializeTestProject({
      projectRoot,
      config: { ...config, recordingPolicy: { mode: "project-skill" } },
    });
    await rm(join(projectRoot, projectSkillRelativePath));

    await expect(
      createPreflightResultRun({
        projectRoot,
        kind: "exploratory",
        exploratoryPayload: { ...readyPayload, readiness },
        execution: "local",
        readiness,
        now,
      }),
    ).rejects.toMatchObject({ code: "project_skill.integrity_error" });
    await expect(readdir(join(projectRoot, ".ai-qa", "runs"))).resolves.toEqual(
      [],
    );
  });

  it("uses one config snapshot for compatibility and the immutable work order", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-cli-"));
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-run-agents-"));
    await initializeTestProject({ projectRoot, config });
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_AGENTS_HOME: agentsHome },
      readStdin: async () => {
        await writeProjectConfig(projectRoot, {
          ...config,
          recordingPolicy: { mode: "project-skill" },
        });
        return JSON.stringify(readyPayload);
      },
    });
    const skillInstall = createCapturedCli({
      env: { AI_QA_AGENTS_HOME: agentsHome },
    });
    expect(
      await runCli(["skill", "install", "--global"], skillInstall.context),
    ).toBe(0);

    const exitCode = await runCli(
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
    );

    expect(exitCode).toBe(0);
    const workOrder = JSON.parse(captured.stdout.join("")) as {
      runId: string;
      projectId: string;
      startedAt: string;
      recordingPolicy: { mode: string };
    };
    expect(workOrder).toMatchObject({
      projectId: "sample-web",
      startedAt: "2026-07-13T00:00:00.000Z",
      recordingPolicy: { mode: "local-only" },
    });
    expect(
      await readFile(
        join(projectRoot, ".ai-qa", "runs", workOrder.runId, "work-order.json"),
        "utf8",
      ),
    ).toBe(JSON.stringify(workOrder));
  });

  it("classifies a missing global skill installation as an environment blocker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-cli-"));
    await initializeTestProject({ projectRoot, config });
    const captured = createCapturedCli({
      cwd: projectRoot,
      readStdin: async () => {
        await writeProjectConfig(projectRoot, {
          ...config,
          recordingPolicy: { mode: "project-skill" },
        });
        return JSON.stringify(readyPayload);
      },
    });

    const exitCode = await runCli(
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
    );

    expect(exitCode).toBe(0);
    const result = JSON.parse(captured.stdout.join("")) as {
      runId: string;
      status: string;
      verdict: string;
      blockerSubtype: string;
    };
    expect(result).toMatchObject({
      status: "completed",
      verdict: "blocked",
      blockerSubtype: "environment",
    });
    expect(result).not.toHaveProperty("workOrder");
    const workOrder = await new RunRepository(
      projectRoot,
      () => new Date("2026-07-13T00:00:00.000Z"),
    ).readVerifiedWorkOrder(result.runId);
    expect(workOrder).toMatchObject({
      preflightResult: true,
      recordingPolicy: { mode: "local-only" },
    });
    expect(workOrder.readiness.status).toBe("not_ready");
    expect(
      workOrder.readiness.checks.some(
        (check) =>
          typeof check === "object" &&
          check !== null &&
          !Array.isArray(check) &&
          check.code === "agent.global_skill" &&
          check.status === "fail",
      ),
    ).toBe(true);
  });

  it("classifies a stale global skill installation as an environment blocker", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-cli-"));
    const agentsHome = await mkdtemp(join(tmpdir(), "ai-qa-run-agents-"));
    await initializeTestProject({
      projectRoot,
      config: {
        ...config,
        recordingPolicy: { mode: "project-skill" },
      },
    });
    await installStaleGlobalSkill(agentsHome);
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_AGENTS_HOME: agentsHome },
      readStdin: () => Promise.resolve(JSON.stringify(readyPayload)),
    });

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
    const result = JSON.parse(captured.stdout.join("")) as {
      runId: string;
      blockerSubtype: string;
    };
    const workOrder = await new RunRepository(
      projectRoot,
      () => new Date("2026-07-13T00:00:00.000Z"),
    ).readVerifiedWorkOrder(result.runId);

    expect(result).toMatchObject({ blockerSubtype: "environment" });
    expect(workOrder.readiness.status).toBe("not_ready");
    expect(workOrder.readiness.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "agent.global_skill",
          status: "fail",
          message: "Global skill status: stale",
        }),
      ]),
    );
  });
});
