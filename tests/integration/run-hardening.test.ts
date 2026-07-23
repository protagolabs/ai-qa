import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { sha256Canonical } from "../../src/core/canonical-json.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import type { LockSignal } from "../../src/core/fs/locking.js";
import { RunJournal } from "../../src/core/runs/journal.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  type AppendRunEvent,
  type RunEvent,
  type WorkOrder,
} from "../../src/core/runs/schema.js";
import { EVENT_SCHEMA_VERSION } from "../../src/schemas/versions.js";
import { finalizeRun } from "../../src/services/run-protocol/finalize-run.js";
import { readRunState } from "../../src/services/run-protocol/read-run-state.js";
import { cancelRun } from "../../src/services/run-protocol/run-lifecycle.js";
import { validateProtocolEvents } from "../../src/services/run-protocol/run-protocol-service.js";
import {
  validateRunSnapshot,
  withRunSession,
  type RunSession,
} from "../../src/services/run-protocol/run-session.js";
import { startExploratoryRun } from "../../src/services/run-protocol/start-exploratory-run.js";
import { VerdictService } from "../helpers/verdict-service.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import { initializeTestProject } from "../helpers/project-fixture.js";
import { createEmptyRunJournal } from "../helpers/run-journal.js";

const fixedNow = () => new Date("2026-07-13T00:00:00.000Z");

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
  readiness: { platform: "web", status: "ready", checks: [] },
});

function makeWorkOrder(runId = "run-1"): WorkOrder {
  return createExploratoryWorkOrder({
    platform: "web",
    projectId: "sample-web",
    runId,
    input: readyPayload,
    evidencePolicy: {
      screenshots: "required",
      defaultSensitivity: "internal",
    },
    startedAt: fixedNow(),
  });
}

function runDirectory(projectRoot: string, runId = "run-1"): string {
  return join(projectRoot, ".ai-qa", "runs", runId);
}

function buildBudgetSizedJournal(): RunEvent[] {
  const events: RunEvent[] = [];
  for (let index = 0; index < 100; index += 1) {
    const actionId = `event-budget-plan-${String(index)}`;
    const stepId = `step-budget-${String(index)}`;
    events.push(
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: actionId,
        runId: "run-1",
        sequence: events.length + 1,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "action",
        idempotencyKey: `budget-plan-${String(index)}`,
        payload: {
          phase: "planned",
          kind: "observation",
          intent: `Observe budget step ${String(index)}`,
          stepId,
          target: { description: `Budget target ${String(index)}` },
        },
        relatedIds: [],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: `event-budget-complete-${String(index)}`,
        runId: "run-1",
        sequence: events.length + 2,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "action",
        idempotencyKey: `complete:${actionId}`,
        payload: {
          phase: "completed",
          actionId,
          toolResult: { summary: `Observed budget step ${String(index)}` },
        },
        relatedIds: [actionId],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: `event-budget-observation-${String(index)}`,
        runId: "run-1",
        sequence: events.length + 3,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "observation",
        idempotencyKey: `observation:${actionId}`,
        payload: {
          actionId,
          stepId,
          summary: `Budget step ${String(index)} is visible`,
          state: { index },
        },
        relatedIds: [actionId],
      },
    );
  }
  return events;
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function createRepositoryRun(projectRoot: string, runId = "run-1") {
  const repository = new RunRepository(projectRoot, fixedNow);
  const workOrder = makeWorkOrder(runId);
  const result = await repository.create(workOrder);
  return { repository, workOrder, ...result };
}

async function readVerifiedWorkOrder(
  repository: RunRepository,
  runId = "run-1",
): Promise<WorkOrder> {
  const events = await repository.journal(runId).readAll();
  return repository.readVerifiedWorkOrder(runId, events);
}

async function initializeProject(): Promise<{ projectRoot: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-hardening-project-"));
  await initializeTestProject({ projectRoot, config });
  return { projectRoot };
}

describe("single-pass protocol validation parity", () => {
  it("accepts completed, failed, recovered, and retried interactions", () => {
    const workOrder = makeWorkOrder();
    const events: RunEvent[] = [
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: "event-success-plan",
        runId: "run-1",
        sequence: 1,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "action",
        idempotencyKey: "success-plan",
        payload: {
          phase: "planned",
          kind: "interaction",
          intent: "Complete the first interaction",
          stepId: "step-success",
          target: { description: "First target" },
        },
        relatedIds: [],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: "event-success-complete",
        runId: "run-1",
        sequence: 2,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "action",
        idempotencyKey: "complete:event-success-plan",
        payload: {
          phase: "completed",
          actionId: "event-success-plan",
          toolResult: { summary: "The first interaction completed" },
        },
        relatedIds: ["event-success-plan"],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: "event-failed-plan",
        runId: "run-1",
        sequence: 3,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "action",
        idempotencyKey: "failed-plan",
        payload: {
          phase: "planned",
          kind: "interaction",
          intent: "Attempt the second interaction",
          stepId: "step-retry",
          target: { description: "Second target" },
        },
        relatedIds: [],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: "event-failed-terminal",
        runId: "run-1",
        sequence: 4,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "action",
        idempotencyKey: "complete:event-failed-plan",
        payload: {
          phase: "unknown",
          actionId: "event-failed-plan",
          toolResult: { summary: "The second interaction result is unknown" },
        },
        relatedIds: ["event-failed-plan"],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: "event-recovery-observation-plan",
        runId: "run-1",
        sequence: 5,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "action",
        idempotencyKey: "recovery-observation-plan",
        payload: {
          phase: "planned",
          kind: "observation",
          intent: "Observe the failed interaction",
          stepId: "step-retry",
          target: { description: "Second target state" },
        },
        relatedIds: [],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: "event-recovery-observation-complete",
        runId: "run-1",
        sequence: 6,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "action",
        idempotencyKey: "complete:event-recovery-observation-plan",
        payload: {
          phase: "completed",
          actionId: "event-recovery-observation-plan",
          toolResult: { summary: "The second target state was observed" },
        },
        relatedIds: ["event-recovery-observation-plan"],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: "event-recovery-observation",
        runId: "run-1",
        sequence: 7,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "observation",
        idempotencyKey: "observation:event-recovery-observation-plan",
        payload: {
          actionId: "event-recovery-observation-plan",
          stepId: "step-retry",
          summary: "The second interaction was not applied",
          state: { applied: false },
        },
        relatedIds: ["event-recovery-observation-plan"],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: "event-recovery",
        runId: "run-1",
        sequence: 8,
        timestamp: fixedNow().toISOString(),
        actor: "ai-qa",
        platform: "web",
        tool: "ai-qa",
        type: "recovery",
        idempotencyKey: "recovery:event-failed-plan",
        payload: {
          actionId: "event-failed-plan",
          resolution: "not_applied",
          observationId: "event-recovery-observation",
          rationale: "The fresh observation shows no state change",
        },
        relatedIds: ["event-failed-plan", "event-recovery-observation"],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: "event-retry-plan",
        runId: "run-1",
        sequence: 9,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "action",
        idempotencyKey: "retry-plan",
        payload: {
          phase: "planned",
          kind: "interaction",
          intent: "Retry the second interaction",
          stepId: "step-retry",
          target: { description: "Second target" },
          recoveryForStepId: "step-retry",
        },
        relatedIds: [],
      },
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: "event-retry-complete",
        runId: "run-1",
        sequence: 10,
        timestamp: fixedNow().toISOString(),
        actor: "agent",
        platform: "web",
        tool: "chrome-devtools-mcp",
        type: "action",
        idempotencyKey: "complete:event-retry-plan",
        payload: {
          phase: "completed",
          actionId: "event-retry-plan",
          toolResult: { summary: "The retry completed" },
        },
        relatedIds: ["event-retry-plan"],
      },
    ];

    expect(() =>
      validateProtocolEvents(events, workOrder, workOrder.runId),
    ).not.toThrow();
  });

  it("validates a budget-sized journal quickly", () => {
    const workOrder = makeWorkOrder();
    const events = buildBudgetSizedJournal();
    const startedAt = performance.now();

    validateProtocolEvents(events, workOrder, workOrder.runId);

    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("run path confinement", () => {
  it("rejects a symlinked events file before reading outside the project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-journal-outside-"));
    const journal = await createEmptyRunJournal(projectRoot, "run-1", fixedNow);
    const eventsPath = join(runDirectory(projectRoot), "events.jsonl");
    const outsideEvents = join(outside, "events.jsonl");
    await writeFile(outsideEvents, "");
    await rm(eventsPath);
    await symlink(outsideEvents, eventsPath);

    await expect(journal.readAll()).rejects.toMatchObject({
      code: "storage.integrity_error",
    });
  });

  it("rejects a symlinked runs root before creating a run outside the project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-runs-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-runs-outside-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    await symlink(outside, join(projectRoot, ".ai-qa", "runs"));

    await expect(createRepositoryRun(projectRoot)).rejects.toMatchObject({
      code: "storage.integrity_error",
    });
    await expect(access(join(outside, "run-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects traversal, absolute, and backslash IDs before creating paths", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-path-"));
    const absolute = resolve(projectRoot, "outside-absolute");
    for (const unsafe of ["../outside", absolute, "..\\outside"]) {
      expect(() => RunJournal.open(projectRoot, unsafe, fixedNow)).toThrow();
    }

    await expectMissing(join(projectRoot, ".ai-qa", "outside"));
    await expectMissing(absolute);
    await expectMissing(join(projectRoot, ".ai-qa", "runs", "..\\outside"));
  });

  it("rejects unsafe repository create/read boundaries without touching outside state", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-repository-path-"));
    const repository = new RunRepository(projectRoot, fixedNow);
    const unsafe = { ...makeWorkOrder(), runId: "../outside" } as WorkOrder;

    await expect(repository.create(unsafe)).rejects.toBeDefined();
    expect(() => repository.journal("../outside")).toThrow();
    await expect(
      repository.readVerifiedWorkOrder("../outside", []),
    ).rejects.toBeDefined();
    await expectMissing(join(projectRoot, ".ai-qa", "outside"));
  });
});

describe("host-authorized exploratory start boundary", () => {
  it("validates project config without an AI QA trust prerequisite", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-host-service-"));
    await mkdir(join(projectRoot, ".ai-qa"), { recursive: true });
    await writeFile(join(projectRoot, ".ai-qa", "config.yaml"), "invalid: [");

    await expect(
      startExploratoryRun({
        projectRoot,
        platform: "web",
        payload: readyPayload,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ name: "YAMLParseError", code: "BAD_INDENT" });
    await expectMissing(join(projectRoot, ".ai-qa", "runs"));
  });

  it("does not use AI_QA_HOME as an authorization gate", async () => {
    const { projectRoot } = await initializeProject();
    const alternateHome = await mkdtemp(
      join(tmpdir(), "ai-qa-alternate-home-"),
    );
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: alternateHome },
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
    expect(await readdir(join(projectRoot, ".ai-qa", "runs"))).toHaveLength(1);
    await expect(
      access(join(alternateHome, "trust.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["kind", "regression"],
    ["platform", "ios"],
    ["execution", "ci"],
  ])(
    "rejects unsupported %s without creating run state",
    async (option, value) => {
      const { projectRoot } = await initializeProject();
      const args = {
        kind: "exploratory",
        platform: "web",
        execution: "local",
        [option]: value,
      };
      const captured = createCapturedCli({
        cwd: projectRoot,
        readStdin: () => Promise.resolve(JSON.stringify(readyPayload)),
      });

      expect(
        await runCli(
          [
            "run",
            "start",
            "--kind",
            args.kind,
            "--platform",
            args.platform,
            "--execution",
            args.execution,
            "--stdin-json",
          ],
          captured.context,
        ),
      ).toBe(1);
      expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
        error: { code: "schema.validation_failed" },
      });
      expect(await readdir(join(projectRoot, ".ai-qa", "runs"))).toEqual([]);
    },
  );
});

describe("strict work-order integrity", () => {
  it("atomically publishes only complete final run directories", async () => {
    const { projectRoot } = await initializeProject();
    const runsRoot = join(projectRoot, ".ai-qa", "runs");
    const residue = join(runsRoot, ".run-staging-run-residue-seeded");
    await mkdir(residue);

    await new RunRepository(projectRoot, fixedNow).create(makeWorkOrder());

    expect((await readdir(runsRoot)).sort()).toEqual([
      ".run-staging-run-residue-seeded",
      "run-1",
    ]);
    expect((await readdir(runDirectory(projectRoot))).sort()).toEqual([
      "events.jsonl",
      "work-order.json",
    ]);
    await expect(
      readVerifiedWorkOrder(new RunRepository(projectRoot, fixedNow)),
    ).resolves.toEqual(makeWorkOrder());
  });

  it("publishes one complete run for concurrent same-ID creators and cleans the loser staging directory", async () => {
    const { projectRoot } = await initializeProject();
    const workOrder = makeWorkOrder();
    const results = await Promise.allSettled([
      new RunRepository(projectRoot, fixedNow).create(workOrder),
      new RunRepository(projectRoot, fixedNow).create(workOrder),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "run.already_exists" } });
    expect(await readdir(join(projectRoot, ".ai-qa", "runs"))).toEqual([
      "run-1",
    ]);
    await expect(
      readVerifiedWorkOrder(new RunRepository(projectRoot, fixedNow)),
    ).resolves.toEqual(workOrder);
  });

  it("preserves run.not_found for a missing work order", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-missing-order-"));
    const repository = new RunRepository(projectRoot, fixedNow);

    await expect(
      repository.readVerifiedWorkOrder("run-missing", []),
    ).rejects.toMatchObject({
      code: "run.not_found",
      message: "Run does not exist",
      details: { runId: "run-missing" },
    });
  });

  it("treats a missing journal after a valid work order as partial corruption", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-partial-run-order-"),
    );
    const { repository } = await createRepositoryRun(projectRoot);
    await rm(join(runDirectory(projectRoot), "events.jsonl"));

    await expect(
      repository.readVerifiedWorkOrder("run-1", []),
    ).rejects.toMatchObject({
      code: "work_order.integrity_error",
      message: "Work order integrity verification failed",
      details: { runId: "run-1" },
    });
  });

  it("does not misreport a symlinked work order as missing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-symlinked-order-"));
    const { repository } = await createRepositoryRun(projectRoot);
    const workOrderPath = join(runDirectory(projectRoot), "work-order.json");
    const outsidePath = join(projectRoot, "outside-work-order.json");
    await writeFile(outsidePath, await readFile(workOrderPath, "utf8"));
    await rm(workOrderPath);
    await symlink(outsidePath, workOrderPath);

    await expect(readVerifiedWorkOrder(repository)).rejects.toMatchObject({
      code: "work_order.integrity_error",
    });
  });

  it.each([
    [
      "unknown fields",
      (source: string) => {
        const value = JSON.parse(source) as Record<string, unknown>;
        value.unexpected = true;
        return JSON.stringify(value);
      },
    ],
    ["malformed JSON", () => "{"],
    [
      "schema-invalid content",
      (source: string) => {
        const value = JSON.parse(source) as Record<string, unknown>;
        value.schemaVersion = 999;
        return JSON.stringify(value);
      },
    ],
  ])("normalizes %s tampering", async (_name, tamper) => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-work-order-tamper-"),
    );
    const { repository } = await createRepositoryRun(projectRoot);
    const path = join(runDirectory(projectRoot), "work-order.json");
    await writeFile(path, tamper(await readFile(path, "utf8")));

    await expect(readVerifiedWorkOrder(repository)).rejects.toMatchObject({
      code: "work_order.integrity_error",
      message: "Work order integrity verification failed",
    });
  });

  it("runtime-validates before persisting and deep-freezes verified work orders", async () => {
    const invalidRoot = await mkdtemp(join(tmpdir(), "ai-qa-invalid-order-"));
    const invalid = { ...makeWorkOrder(), goal: "   " } as WorkOrder;
    await expect(
      new RunRepository(invalidRoot, fixedNow).create(invalid),
    ).rejects.toBeDefined();
    await expectMissing(runDirectory(invalidRoot));

    const validRoot = await mkdtemp(join(tmpdir(), "ai-qa-frozen-order-"));
    const { repository } = await createRepositoryRun(validRoot);
    const verified = await readVerifiedWorkOrder(repository);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.acceptanceCriteria)).toBe(true);
    expect(Object.isFrozen(verified.acceptanceCriteria[0])).toBe(true);
    expect(
      Object.isFrozen(verified.acceptanceCriteria[0]?.requiredEvidence),
    ).toBe(true);
    expect(Object.isFrozen(verified.readiness.checks)).toBe(true);
    expect(Object.isFrozen(verified.budget)).toBe(true);
  });

  it.each([
    [
      "ci execution",
      (workOrder: WorkOrder) =>
        ({ ...workOrder, execution: "ci" }) as WorkOrder,
    ],
    [
      "not-ready status",
      (workOrder: WorkOrder) =>
        ({
          ...workOrder,
          readiness: { ...workOrder.readiness, status: "not_ready" },
        }) as WorkOrder,
    ],
    [
      "non-default tool-call count",
      (workOrder: WorkOrder) =>
        ({
          ...workOrder,
          budget: { ...workOrder.budget, maxToolCalls: 101 },
        }) as WorkOrder,
    ],
    [
      "non-default recovery count",
      (workOrder: WorkOrder) =>
        ({
          ...workOrder,
          budget: { ...workOrder.budget, maxRecoveryActions: 11 },
        }) as WorkOrder,
    ],
    [
      "wrong deadline",
      (workOrder: WorkOrder) =>
        ({
          ...workOrder,
          budget: {
            ...workOrder.budget,
            deadline: "2026-07-13T00:29:59.999Z",
          },
        }) as WorkOrder,
    ],
  ])(
    "rejects exploratory %s before creating run state",
    async (_name, mutate) => {
      const projectRoot = await mkdtemp(
        join(tmpdir(), "ai-qa-order-invariant-"),
      );
      await expect(
        new RunRepository(projectRoot, fixedNow).create(
          mutate(makeWorkOrder()),
        ),
      ).rejects.toBeDefined();
      await expectMissing(runDirectory(projectRoot));
    },
  );

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["Date", new Date("2026-07-13T00:00:00.000Z")],
    [
      "class instance",
      new (class Box {
        value = "box";
      })(),
    ],
    ["function", () => "function"],
    ["symbol", Symbol("symbol")],
  ])(
    "rejects non-JSON required steps containing %s before persistence",
    async (_name, invalid) => {
      const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-order-json-"));
      const workOrder = {
        ...makeWorkOrder(),
        requiredSteps: [invalid],
      } as unknown as WorkOrder;

      await expect(
        new RunRepository(projectRoot, fixedNow).create(workOrder),
      ).rejects.toBeDefined();
      await expectMissing(runDirectory(projectRoot));
    },
  );

  it("rejects cyclic and non-JSON readiness checks before persistence", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-order-checks-"));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const workOrder = {
      ...makeWorkOrder(),
      readiness: {
        platform: "web",
        status: "ready",
        checks: [cyclic, new Date("2026-07-13T00:00:00.000Z")],
      },
    } as WorkOrder;

    await expect(
      new RunRepository(projectRoot, fixedNow).create(workOrder),
    ).rejects.toBeDefined();
    await expectMissing(runDirectory(projectRoot));
  });
});

describe("journal and start-anchor integrity", () => {
  it.each([
    [
      "non-contiguous sequence",
      (event: RunEvent) => JSON.stringify({ ...event, sequence: 2 }) + "\n",
    ],
    [
      "foreign run ID",
      (event: RunEvent) => JSON.stringify({ ...event, runId: "run-2" }) + "\n",
    ],
    ["malformed JSONL", () => "{\n"],
  ])("returns a stable error for %s", async (_name, tamper) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-tamper-"));
    const journal = await createEmptyRunJournal(projectRoot, "run-1", fixedNow);
    const event = await journal.append({
      type: "observation",
      actor: "agent",
      platform: "web",
      tool: "browser",
      payload: {
        summary: "The page is visible",
        state: { visible: true },
        actionId: "event-action",
      },
      relatedIds: [],
    });
    await writeFile(
      join(runDirectory(projectRoot), "events.jsonl"),
      tamper(event),
    );

    await expect(journal.readAll()).rejects.toMatchObject({
      code: "journal.integrity_error",
      message: "Run journal integrity verification failed",
    });
  });

  it("rejects a misplaced start anchor", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-anchor-moved-"));
    const { repository } = await createRepositoryRun(projectRoot);
    const path = join(runDirectory(projectRoot), "events.jsonl");
    const anchor = JSON.parse(
      (await readFile(path, "utf8")).trim(),
    ) as RunEvent;
    const observation: RunEvent = {
      ...anchor,
      id: "event-observation",
      sequence: 1,
      actor: "agent",
      tool: "browser",
      type: "observation",
      payload: {
        summary: "The page is visible",
        state: { visible: true },
        actionId: "event-action",
      },
    };
    const moved = { ...anchor, id: "event-moved", sequence: 2 };
    await writeFile(
      path,
      `${JSON.stringify(observation)}\n${JSON.stringify(moved)}\n`,
    );

    await expect(
      repository.readVerifiedWorkOrder("run-1", [observation, moved]),
    ).rejects.toMatchObject({
      code: "work_order.integrity_error",
    });
  });

  it("rejects duplicate and non-exact start anchors", async () => {
    const duplicateRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-anchor-duplicate-"),
    );
    const duplicate = await createRepositoryRun(duplicateRoot);
    await duplicate.journal.append({
      type: "run",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      payload: { phase: "started", workOrderHash: duplicate.workOrderHash },
      relatedIds: [],
    });
    await expect(
      readVerifiedWorkOrder(duplicate.repository),
    ).rejects.toMatchObject({ code: "work_order.integrity_error" });

    const extraRoot = await mkdtemp(join(tmpdir(), "ai-qa-anchor-extra-"));
    const extra = await createRepositoryRun(extraRoot);
    const path = join(runDirectory(extraRoot), "events.jsonl");
    const anchor = JSON.parse(
      (await readFile(path, "utf8")).trim(),
    ) as RunEvent;
    await writeFile(
      path,
      `${JSON.stringify({
        ...anchor,
        payload: { ...(anchor.payload as object), unexpected: true },
      })}\n`,
    );
    const extraAnchor = {
      ...anchor,
      payload: { ...(anchor.payload as object), unexpected: true },
    } as unknown as RunEvent;
    await expect(
      extra.repository.readVerifiedWorkOrder("run-1", [extraAnchor]),
    ).rejects.toMatchObject({ code: "work_order.integrity_error" });
  });

  it("verifies against supplied parsed events without rereading the journal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-anchor-journal-"));
    const { repository, workOrder } = await createRepositoryRun(projectRoot);
    const events = await repository.journal("run-1").readAll();
    await writeFile(join(runDirectory(projectRoot), "events.jsonl"), "{");
    await expect(
      repository.readVerifiedWorkOrder("run-1", events),
    ).resolves.toEqual(workOrder);
  });

  it.each([
    ["tool", (event: RunEvent) => ({ ...event, tool: "browser" })],
    [
      "idempotency key",
      (event: RunEvent) => ({ ...event, idempotencyKey: "wrong-start-key" }),
    ],
    ["related IDs", (event: RunEvent) => ({ ...event, relatedIds: ["other"] })],
  ])("rejects start-anchor tampering of %s", async (_name, tamper) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-anchor-fields-"));
    const { repository } = await createRepositoryRun(projectRoot);
    const path = join(runDirectory(projectRoot), "events.jsonl");
    const anchor = JSON.parse(
      (await readFile(path, "utf8")).trim(),
    ) as RunEvent;
    await writeFile(path, `${JSON.stringify(tamper(anchor))}\n`);

    await expect(readVerifiedWorkOrder(repository)).rejects.toMatchObject({
      code: "work_order.integrity_error",
    });
  });
});

describe("recoverable exclusive run creation", () => {
  it("removes only an owned partial run and allows retry", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-retry-"));
    let first = true;
    const repository = new RunRepository(projectRoot, () => {
      if (first) {
        first = false;
        throw new Error("injected clock failure");
      }
      return fixedNow();
    });

    await expect(repository.create(makeWorkOrder())).rejects.toThrow(
      "injected clock failure",
    );
    await expectMissing(runDirectory(projectRoot));
    const retry = await repository.create(makeWorkOrder());
    expect(retry.workOrderHash).toMatch(/^sha256:/);
  });

  it("preserves pre-existing run state and returns a domain collision", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-existing-"));
    const directory = runDirectory(projectRoot);
    await mkdir(directory, { recursive: true });
    const marker = join(directory, "preserve.txt");
    await writeFile(marker, "preserve");

    await expect(
      new RunRepository(projectRoot, fixedNow).create(makeWorkOrder()),
    ).rejects.toMatchObject({ code: "run.already_exists" });
    await expect(readFile(marker, "utf8")).resolves.toBe("preserve");
  });

  it("creates journal and work-order files exclusively with mode 0600", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-mode-"));
    await createRepositoryRun(repositoryRoot);
    expect(
      (await stat(join(runDirectory(repositoryRoot), "work-order.json"))).mode &
        0o777,
    ).toBe(0o600);
    expect(
      (await stat(join(runDirectory(repositoryRoot), "events.jsonl"))).mode &
        0o777,
    ).toBe(0o600);
  });
});

describe("durable journal concurrency", () => {
  it("serializes simultaneous appends from separate journal instances", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-concurrent-journal-"),
    );
    await createEmptyRunJournal(projectRoot, "run-1", fixedNow);
    const left = RunJournal.open(projectRoot, "run-1", fixedNow);
    const right = RunJournal.open(projectRoot, "run-1", fixedNow);

    const events = await Promise.all([
      left.append({
        type: "observation",
        actor: "agent",
        platform: "web",
        tool: "browser",
        payload: {
          summary: "Left append",
          state: { side: "left" },
          actionId: "event-left-action",
        },
        relatedIds: [],
      }),
      right.append({
        type: "observation",
        actor: "agent",
        platform: "web",
        tool: "browser",
        payload: {
          summary: "Right append",
          state: { side: "right" },
          actionId: "event-right-action",
        },
        relatedIds: [],
      }),
    ]);

    expect(events.map((event) => event.sequence).sort()).toEqual([1, 2]);
    const persisted = await left.readAll();
    expect(persisted.map((event) => event.sequence)).toEqual([1, 2]);
    expect(new Set(persisted.map((event) => event.id)).size).toBe(2);
  });

  it("returns the original event for canonical-equal reordered retries", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-canonical-retry-"));
    const journal = await createEmptyRunJournal(projectRoot, "run-1", fixedNow);
    const first = await journal.append({
      type: "observation",
      actor: "agent",
      platform: "web",
      tool: "agent",
      idempotencyKey: "decision-1",
      payload: {
        summary: "Canonical observation",
        state: {
          nested: { left: 1, right: 2 },
          values: [null, true, "ok", { finite: 1.5 }],
        },
        actionId: "event-canonical-action",
      },
      relatedIds: ["one", "two"],
    });
    const retry = await journal.append({
      relatedIds: ["one", "two"],
      payload: {
        actionId: "event-canonical-action",
        state: {
          values: [null, true, "ok", { finite: 1.5 }],
          nested: { right: 2, left: 1 },
        },
        summary: "Canonical observation",
      },
      idempotencyKey: "decision-1",
      tool: "agent",
      platform: "web",
      actor: "agent",
      type: "observation",
    });

    expect(retry.id).toBe(first.id);
    expect(await journal.readAll()).toHaveLength(1);
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["Date", new Date("2026-07-13T00:00:00.000Z")],
    [
      "class instance",
      new (class Box {
        value = "box";
      })(),
    ],
    ["function", () => "function"],
    ["symbol", Symbol("symbol")],
  ])(
    "rejects event payload %s without appending bytes",
    async (_name, invalid) => {
      const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-event-json-"));
      const journal = await createEmptyRunJournal(
        projectRoot,
        "run-1",
        fixedNow,
      );
      const path = join(runDirectory(projectRoot), "events.jsonl");

      await expect(
        journal.append({
          type: "observation",
          actor: "agent",
          platform: "web",
          tool: "browser",
          payload: invalid as never,
          relatedIds: [],
        }),
      ).rejects.toBeDefined();
      await expect(readFile(path, "utf8")).resolves.toBe("");
    },
  );

  it("rejects cyclic event payloads without appending bytes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-event-cycle-"));
    const journal = await createEmptyRunJournal(projectRoot, "run-1", fixedNow);
    const path = join(runDirectory(projectRoot), "events.jsonl");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(
      journal.append({
        type: "observation",
        actor: "agent",
        platform: "web",
        tool: "browser",
        payload: cyclic as never,
        relatedIds: [],
      }),
    ).rejects.toBeDefined();
    await expect(readFile(path, "utf8")).resolves.toBe("");
  });
});

describe("run session command atomicity", () => {
  it("preserves historical JSON field order during a batch rewrite", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-session-historical-bytes-"),
    );
    await createRepositoryRun(projectRoot);
    const eventsPath = join(
      projectRoot,
      ".ai-qa",
      "runs",
      "run-1",
      "events.jsonl",
    );
    const started = JSON.parse(await readFile(eventsPath, "utf8")) as RunEvent;
    const historicalLine = JSON.stringify({
      payload: started.payload,
      type: started.type,
      relatedIds: started.relatedIds,
      tool: started.tool,
      platform: started.platform,
      actor: started.actor,
      timestamp: started.timestamp,
      sequence: started.sequence,
      runId: started.runId,
      id: started.id,
      schemaVersion: started.schemaVersion,
      idempotencyKey: started.idempotencyKey,
    });
    await writeFile(eventsPath, `${historicalLine}\n`);
    const firstPayload = {
      kind: "semantic" as const,
      rationale: "First decision in one atomic batch",
      relatedIds: [],
    };
    const secondPayload = {
      kind: "semantic" as const,
      rationale: "Second decision in one atomic batch",
      relatedIds: [],
    };

    await withRunSession(
      { projectRoot, runId: "run-1", now: fixedNow },
      (session) =>
        session.append([
          {
            type: "decision",
            actor: "agent",
            platform: "web",
            tool: "ai-qa",
            idempotencyKey: `decision:${sha256Canonical(firstPayload)}`,
            payload: firstPayload,
            relatedIds: [],
          },
          {
            type: "decision",
            actor: "agent",
            platform: "web",
            tool: "ai-qa",
            idempotencyKey: `decision:${sha256Canonical(secondPayload)}`,
            payload: secondPayload,
            relatedIds: [],
          },
        ]),
    );

    const [rewrittenHistoricalLine] = (await readFile(eventsPath, "utf8"))
      .trimEnd()
      .split("\n");
    expect(rewrittenHistoricalLine).toBe(historicalLine);
  });

  it("isolates beforeValidate from the parsed session graph", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-session-before-validate-immutable-"),
    );
    const { repository, workOrder } = await createRepositoryRun(projectRoot);
    let eventMutationAccepted: boolean | undefined;
    let payloadMutationAccepted: boolean | undefined;
    let workOrderMutationAccepted: boolean | undefined;

    const [appended] = await withRunSession(
      {
        projectRoot,
        runId: "run-1",
        now: fixedNow,
        beforeValidate: ({ events, workOrder: inspectionWorkOrder }) => {
          const started = events[0];
          if (started === undefined) throw new Error("missing start event");
          eventMutationAccepted = Reflect.set(started, "sequence", 100);
          payloadMutationAccepted = Reflect.set(
            started.payload,
            "workOrderHash",
            "sha256:hook-mutation",
          );
          workOrderMutationAccepted = Reflect.set(
            inspectionWorkOrder,
            "goal",
            "Hook-mutated goal",
          );
          return Promise.resolve();
        },
      },
      async (session) => {
        expect(session.snapshot.workOrder.goal).toBe(workOrder.goal);
        const started = session.snapshot.events[0];
        expect(started).toMatchObject({ sequence: 1 });
        if (
          started === undefined ||
          started.payload === null ||
          typeof started.payload !== "object" ||
          !("workOrderHash" in started.payload)
        ) {
          throw new Error("missing start work-order hash");
        }
        expect(started.payload.workOrderHash).toBe(sha256Canonical(workOrder));
        const payload = {
          kind: "semantic" as const,
          rationale: "Append after immutable pre-validation inspection",
          relatedIds: [],
        };
        return session.append([
          {
            type: "decision",
            actor: "agent",
            platform: "web",
            tool: "ai-qa",
            idempotencyKey: `decision:${sha256Canonical(payload)}`,
            payload,
            relatedIds: [],
          },
        ]);
      },
    );

    expect({
      eventMutationAccepted,
      payloadMutationAccepted,
      workOrderMutationAccepted,
      appendedSequence: appended?.sequence,
    }).toEqual({
      eventMutationAccepted: false,
      payloadMutationAccepted: false,
      workOrderMutationAccepted: false,
      appendedSequence: 2,
    });
    await expect(repository.journal("run-1").readAll()).resolves.toMatchObject([
      { sequence: 1, type: "run" },
      { sequence: 2, type: "decision" },
    ]);
  });

  it("rejects a supplied lifecycle that disagrees with event history", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-session-lifecycle-coherence-"),
    );
    await createRepositoryRun(projectRoot);

    await withRunSession(
      { projectRoot, runId: "run-1", now: fixedNow },
      (session) => {
        const snapshot = session.snapshot;
        expect(() =>
          validateRunSnapshot({
            ...snapshot,
            lifecycle: {
              ...snapshot.lifecycle,
              current: {
                ...snapshot.lifecycle.current,
                payload: {
                  phase: "interrupted",
                  previousLifecycleEventId: snapshot.lifecycle.current.event.id,
                },
              },
            },
          }),
        ).toThrowError(
          expect.objectContaining({ code: "run_protocol.integrity_error" }),
        );
      },
    );
  });

  it("deep-freezes the session graph and append results", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-session-immutable-snapshot-"),
    );
    await createRepositoryRun(projectRoot);
    await new VerdictService(projectRoot, "run-1", fixedNow).set({
      classification: "not_verified",
      reasonCode: "incomplete_coverage",
      summary: "Coverage remains incomplete",
      criterionResults: [],
    });

    await withRunSession(
      { projectRoot, runId: "run-1", now: fixedNow },
      async (session) => {
        const snapshot = session.snapshot;
        const effectiveVerdict = snapshot.lifecycle.effectiveVerdict;
        if (effectiveVerdict === undefined)
          throw new Error("missing effective verdict");
        const verdictEvent = snapshot.events.find(
          (event) => event.type === "verdict",
        );
        if (verdictEvent === undefined)
          throw new Error("missing verdict event");

        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.workOrder)).toBe(true);
        expect(Object.isFrozen(snapshot.workOrder.acceptanceCriteria[0])).toBe(
          true,
        );
        expect(
          Object.isFrozen(
            snapshot.workOrder.acceptanceCriteria[0]!.requiredEvidence,
          ),
        ).toBe(true);
        expect(Object.isFrozen(snapshot.events)).toBe(true);
        expect(Object.isFrozen(snapshot.events[0])).toBe(true);
        expect(Object.isFrozen(snapshot.events[0]!.payload)).toBe(true);
        expect(Object.isFrozen(snapshot.events[0]!.relatedIds)).toBe(true);
        expect(Object.isFrozen(verdictEvent.payload.criterionResults)).toBe(
          true,
        );
        expect(Object.isFrozen(snapshot.lifecycle)).toBe(true);
        expect(Object.isFrozen(snapshot.lifecycle.current)).toBe(true);
        expect(Object.isFrozen(snapshot.lifecycle.current.payload)).toBe(true);
        expect(Object.isFrozen(effectiveVerdict)).toBe(true);
        expect(Object.isFrozen(effectiveVerdict.payload)).toBe(true);
        expect(Object.isFrozen(effectiveVerdict.payload.criterionResults)).toBe(
          true,
        );

        expect(
          Reflect.set(
            snapshot.lifecycle.current.payload,
            "phase",
            "interrupted",
          ),
        ).toBe(false);
        expect(
          Reflect.set(snapshot.events[0]!.payload, "phase", "interrupted"),
        ).toBe(false);
        expect(() =>
          snapshot.events[0]!.relatedIds.push("caller-mutation"),
        ).toThrow(TypeError);
        expect(() =>
          (verdictEvent.payload.criterionResults as unknown[]).push({
            criterionId: "caller-mutation",
          }),
        ).toThrow(TypeError);
        expect(() =>
          snapshot.workOrder.acceptanceCriteria[0]!.requiredEvidence.push(
            "caller-mutation",
          ),
        ).toThrow(TypeError);
        expect(() =>
          (effectiveVerdict.payload.criterionResults as unknown[]).push({
            criterionId: "caller-mutation",
          }),
        ).toThrow(TypeError);

        const decisionPayload = {
          kind: "semantic" as const,
          rationale: "The immutable snapshot still permits a valid append",
          relatedIds: [],
        };
        const [decision] = await session.append([
          {
            type: "decision",
            actor: "agent",
            platform: "web",
            tool: "ai-qa",
            idempotencyKey: `decision:${sha256Canonical(decisionPayload)}`,
            payload: decisionPayload,
            relatedIds: [],
          },
        ]);
        expect(decision).toBeDefined();
        expect(Object.isFrozen(decision)).toBe(true);
        expect(Object.isFrozen(decision!.payload)).toBe(true);
        expect(Object.isFrozen(decision!.relatedIds)).toBe(true);
        expect(session.state()).toMatchObject({
          status: "running",
          effectiveVerdict: "not_verified",
        });
      },
    );
  });

  it("rejects snapshot access after the session callback escapes", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-session-escaped-snapshot-"),
    );
    await createRepositoryRun(projectRoot);
    let escaped: RunSession | undefined;

    await withRunSession(
      { projectRoot, runId: "run-1", now: fixedNow },
      (session) => {
        escaped = session;
      },
    );

    expect(() => escaped?.snapshot).toThrowError(
      expect.objectContaining({ code: "storage.lock_compromised" }),
    );
  });

  it("returns state computed from the same critical section as the append", async () => {
    const { projectRoot } = await initializeProject();
    const repository = new RunRepository(projectRoot, fixedNow);
    await repository.create(makeWorkOrder());
    const concurrentJournal = repository.journal("run-1");
    const decisionPayload = {
      kind: "semantic" as const,
      rationale: "A concurrent writer recorded a later semantic decision",
      relatedIds: [],
    };
    let concurrentWrite: Promise<RunEvent> | undefined;
    // The test must invoke the original method with the intercepted journal.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalReadLocked = RunJournal.prototype.readLocked;
    const readBack = vi
      .spyOn(RunJournal.prototype, "readLocked")
      .mockImplementation(async function <T>(
        this: RunJournal,
        inspect: (
          events: readonly RunEvent[],
          signal: LockSignal,
          serialized: Buffer,
        ) => T | Promise<T>,
      ): Promise<T> {
        if (this === concurrentJournal) {
          return originalReadLocked.call(this, inspect) as Promise<T>;
        }
        if (inspect.length >= 2) {
          const result = (await originalReadLocked.call(this, inspect)) as T;
          concurrentWrite ??= concurrentJournal.append({
            type: "decision",
            actor: "agent",
            platform: "web",
            tool: "ai-qa",
            idempotencyKey: `decision:${sha256Canonical(decisionPayload)}`,
            payload: decisionPayload,
            relatedIds: [],
          });
          await concurrentWrite;
          return result;
        }
        concurrentWrite ??= concurrentJournal.append({
          type: "decision",
          actor: "agent",
          platform: "web",
          tool: "ai-qa",
          idempotencyKey: `decision:${sha256Canonical(decisionPayload)}`,
          payload: decisionPayload,
          relatedIds: [],
        });
        await concurrentWrite;
        return (await originalReadLocked.call(this, inspect)) as T;
      });
    const captured = createCapturedCli({
      cwd: projectRoot,
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            idempotencyKey: "critical-section-plan",
            kind: "interaction",
            intent: "Plan before the concurrent decision",
            tool: "chrome-devtools-mcp",
            target: { description: "Login button" },
          }),
        ),
    });

    try {
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
    } finally {
      readBack.mockRestore();
    }
    concurrentWrite ??= concurrentJournal.append({
      type: "decision",
      actor: "agent",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: `decision:${sha256Canonical(decisionPayload)}`,
      payload: decisionPayload,
      relatedIds: [],
    });
    await concurrentWrite;

    const output = JSON.parse(captured.stdout[0]!) as {
      sequence: number;
      state: { status: string; requiresFreshObservation: boolean };
      permittedNextActions: string[];
    };
    expect(output).toMatchObject({
      sequence: 2,
      state: { status: "running", requiresFreshObservation: false },
      permittedNextActions: ["invoke-tool", "action.complete"],
    });
    expect((await concurrentJournal.readAll()).at(-1)).toMatchObject({
      sequence: 3,
      type: "decision",
    });
  });

  it("prints resume state from its command session without a second read", async () => {
    const { projectRoot } = await initializeProject();
    const repository = new RunRepository(projectRoot, fixedNow);
    await repository.create(makeWorkOrder());
    const concurrentJournal = repository.journal("run-1");
    let commandReads = 0;
    let interruptionInjected = false;
    // The test must invoke the original method with each intercepted journal.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalReadLocked = RunJournal.prototype.readLocked;
    const readBack = vi
      .spyOn(RunJournal.prototype, "readLocked")
      .mockImplementation(async function <T>(
        this: RunJournal,
        inspect: (
          events: readonly RunEvent[],
          signal: LockSignal,
          serialized: Buffer,
        ) => T | Promise<T>,
      ): Promise<T> {
        if (this === concurrentJournal) {
          return originalReadLocked.call(this, inspect) as Promise<T>;
        }
        commandReads += 1;
        const result = (await originalReadLocked.call(this, inspect)) as T;
        if (!interruptionInjected) {
          interruptionInjected = true;
          const current = (await concurrentJournal.readAll()).findLast(
            (event) => event.type === "run",
          );
          if (current === undefined) throw new Error("missing lifecycle event");
          await concurrentJournal.append({
            type: "run",
            actor: "ai-qa",
            platform: "web",
            tool: "ai-qa",
            idempotencyKey: `interrupt:run-1:${current.id}`,
            payload: {
              phase: "interrupted",
              previousLifecycleEventId: current.id,
            },
            relatedIds: [current.id],
          });
        }
        return result;
      });
    const captured = createCapturedCli({
      cwd: projectRoot,
      now: fixedNow,
    });

    try {
      expect(
        await runCli(
          ["--project", projectRoot, "run", "resume", "run-1"],
          captured.context,
        ),
      ).toBe(0);
    } finally {
      readBack.mockRestore();
    }

    expect(commandReads).toBe(1);
    expect(JSON.parse(captured.stdout[0]!)).toEqual({
      runId: "run-1",
      status: "running",
      requiresFreshObservation: true,
      permittedNextActions: ["action.plan:observation"],
    });
    expect((await concurrentJournal.readAll()).at(-1)?.payload).toMatchObject({
      phase: "interrupted",
    });
  });

  it("commits cancellation verdict and lifecycle together", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-session-cancel-batch-"),
    );
    const { repository } = await createRepositoryRun(projectRoot);
    const eventsPath = join(runDirectory(projectRoot), "events.jsonl");
    const before = await stat(eventsPath);

    const result = await cancelRun({
      projectRoot,
      runId: "run-1",
      reason: "The operator stopped the run",
      now: fixedNow,
    });

    const after = await stat(eventsPath);
    const events = await repository.journal("run-1").readAll();
    const [verdict, cancelled] = events.slice(-2);
    expect(after.ino).not.toBe(before.ino);
    expect(verdict).toMatchObject({
      type: "verdict",
      sequence: events.length - 1,
      payload: {
        classification: "not_verified",
        reasonCode: "cancelled",
      },
    });
    expect(cancelled).toMatchObject({
      type: "run",
      sequence: events.length,
      payload: {
        phase: "cancelled",
        verdictId: verdict?.id,
        reason: "The operator stopped the run",
      },
    });
    expect(result).toEqual({
      runId: "run-1",
      status: "cancelled",
      verdict: "not_verified",
      state: {
        status: "cancelled",
        effectiveVerdict: "not_verified",
        requiresFreshObservation: false,
      },
      permittedNextActions: ["report.generate"],
    });
    await expect(
      readRunState({ projectRoot, runId: "run-1", now: fixedNow }),
    ).resolves.toMatchObject({
      status: "cancelled",
      effectiveVerdict: "not_verified",
      permittedNextActions: ["report.generate"],
    });
  });

  it("persists nothing when a batch fails aggregate validation", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-session-invalid-batch-"),
    );
    const repository = new RunRepository(projectRoot, fixedNow);
    const workOrder = {
      ...makeWorkOrder(),
      readiness: { platform: "web", status: "not_ready", checks: [] },
      preflightResult: true,
    } as WorkOrder;
    await repository.create(workOrder);
    await new VerdictService(projectRoot, "run-1", fixedNow).set({
      classification: "not_verified",
      reasonCode: "incomplete_coverage",
      summary: "The preflight run has incomplete coverage",
      criterionResults: [],
    });
    await finalizeRun({ projectRoot, runId: "run-1", now: fixedNow });
    const journal = repository.journal("run-1");
    const events = await journal.readAll();
    const verdict = events.findLast((event) => event.type === "verdict");
    if (verdict === undefined) throw new Error("missing completed verdict");
    const eventsPath = join(runDirectory(projectRoot), "events.jsonl");
    const before = await readFile(eventsPath);
    const decisionPayload = {
      kind: "semantic" as const,
      rationale: "This first batch member is protocol-valid",
      relatedIds: [],
    };
    const validDecision: RunEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: "event-valid-post-completion-decision",
      runId: "run-1",
      sequence: events.length + 1,
      timestamp: fixedNow().toISOString(),
      type: "decision",
      actor: "agent",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: `decision:${sha256Canonical(decisionPayload)}`,
      payload: decisionPayload,
      relatedIds: [],
    };
    const invalidLifecycle: RunEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: "event-invalid-post-completion-cancel",
      runId: "run-1",
      sequence: events.length + 2,
      timestamp: fixedNow().toISOString(),
      type: "run",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "cancel:run-1",
      payload: {
        phase: "cancelled",
        verdictId: verdict.id,
        reason: "This lifecycle transition is invalid after completion",
      },
      relatedIds: [verdict.id],
    };
    expect(() =>
      validateProtocolEvents(
        [...events, validDecision, invalidLifecycle],
        workOrder,
        "run-1",
      ),
    ).not.toThrow();
    const inputs: AppendRunEvent[] = [
      {
        type: "decision",
        actor: "agent",
        platform: "web",
        tool: "ai-qa",
        idempotencyKey: validDecision.idempotencyKey,
        payload: decisionPayload,
        relatedIds: [],
      },
      {
        type: "run",
        actor: "ai-qa",
        platform: "web",
        tool: "ai-qa",
        idempotencyKey: "cancel:run-1",
        payload: invalidLifecycle.payload,
        relatedIds: [verdict.id],
      },
    ];
    expect(inputs).toHaveLength(2);
    await expect(
      withRunSession(
        { projectRoot, runId: "run-1", now: fixedNow },
        (session) => session.append(inputs),
      ),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
    expect(await readFile(eventsPath)).toEqual(before);
  });
});
