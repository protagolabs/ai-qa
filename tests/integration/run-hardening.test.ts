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
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { RunJournal } from "../../src/core/runs/journal.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  type RunEvent,
  type WorkOrder,
} from "../../src/core/runs/schema.js";
import { startExploratoryRun } from "../../src/services/run-protocol/start-exploratory-run.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import { initializeTestProject } from "../helpers/project-fixture.js";

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

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function createRepositoryRun(projectRoot: string, runId = "run-1") {
  const repository = new RunRepository(projectRoot, fixedNow);
  const workOrder = makeWorkOrder(runId);
  const result = await repository.create(workOrder);
  return { repository, workOrder, ...result };
}

async function initializeProject(): Promise<{ projectRoot: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-hardening-project-"));
  await initializeTestProject({ projectRoot, config });
  return { projectRoot };
}

describe("run path confinement", () => {
  it("rejects a symlinked runs root before creating a journal outside the project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-journal-outside-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    await symlink(outside, join(projectRoot, ".ai-qa", "runs"));

    await expect(
      RunJournal.create(projectRoot, "run-1", fixedNow),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
    await expect(access(join(outside, "run-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a symlinked events file before reading outside the project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-journal-outside-"));
    const journal = await RunJournal.create(projectRoot, "run-1", fixedNow);
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
      await expect(
        RunJournal.create(projectRoot, unsafe, fixedNow),
      ).rejects.toBeDefined();
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
      repository.readVerifiedWorkOrder("../outside"),
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
      new RunRepository(projectRoot, fixedNow).readVerifiedWorkOrder("run-1"),
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
      new RunRepository(projectRoot, fixedNow).readVerifiedWorkOrder("run-1"),
    ).resolves.toEqual(workOrder);
  });

  it("preserves run.not_found for a missing work order", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-missing-order-"));
    const repository = new RunRepository(projectRoot, fixedNow);

    await expect(
      repository.readVerifiedWorkOrder("run-missing"),
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
      repository.readVerifiedWorkOrder("run-1"),
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

    await expect(
      repository.readVerifiedWorkOrder("run-1"),
    ).rejects.toMatchObject({ code: "work_order.integrity_error" });
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

    await expect(
      repository.readVerifiedWorkOrder("run-1"),
    ).rejects.toMatchObject({
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
    const verified = await repository.readVerifiedWorkOrder("run-1");
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
    ["malformed JSONL", () => "{"],
  ])("returns a stable error for %s", async (_name, tamper) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-journal-tamper-"));
    const journal = await RunJournal.create(projectRoot, "run-1", fixedNow);
    const event = await journal.append({
      type: "observation",
      actor: "agent",
      platform: "web",
      tool: "browser",
      payload: { state: "visible" },
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
      payload: { state: "visible" },
    };
    const moved = { ...anchor, id: "event-moved", sequence: 2 };
    await writeFile(
      path,
      `${JSON.stringify(observation)}\n${JSON.stringify(moved)}\n`,
    );

    await expect(
      repository.readVerifiedWorkOrder("run-1"),
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
      duplicate.repository.readVerifiedWorkOrder("run-1"),
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
    await expect(
      extra.repository.readVerifiedWorkOrder("run-1"),
    ).rejects.toMatchObject({ code: "work_order.integrity_error" });
  });

  it("wraps journal corruption as work-order integrity failure", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-anchor-journal-"));
    const { repository } = await createRepositoryRun(projectRoot);
    await writeFile(join(runDirectory(projectRoot), "events.jsonl"), "{");
    await expect(
      repository.readVerifiedWorkOrder("run-1"),
    ).rejects.toMatchObject({
      code: "work_order.integrity_error",
    });
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

    await expect(
      repository.readVerifiedWorkOrder("run-1"),
    ).rejects.toMatchObject({
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
    const journalRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-journal-exclusive-"),
    );
    await RunJournal.create(journalRoot, "run-1", fixedNow);
    await expect(
      RunJournal.create(journalRoot, "run-1", fixedNow),
    ).rejects.toMatchObject({ code: "run_journal.already_exists" });

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
    await RunJournal.create(projectRoot, "run-1", fixedNow);
    const left = RunJournal.open(projectRoot, "run-1", fixedNow);
    const right = RunJournal.open(projectRoot, "run-1", fixedNow);

    const events = await Promise.all([
      left.append({
        type: "observation",
        actor: "agent",
        platform: "web",
        tool: "browser",
        payload: { side: "left" },
        relatedIds: [],
      }),
      right.append({
        type: "observation",
        actor: "agent",
        platform: "web",
        tool: "browser",
        payload: { side: "right" },
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
    const journal = await RunJournal.create(projectRoot, "run-1", fixedNow);
    const first = await journal.append({
      type: "decision",
      actor: "agent",
      platform: "web",
      tool: "agent",
      idempotencyKey: "decision-1",
      payload: {
        phase: "continue",
        nested: { left: 1, right: 2 },
        values: [null, true, "ok", { finite: 1.5 }],
      },
      relatedIds: ["one", "two"],
    });
    const retry = await journal.append({
      relatedIds: ["one", "two"],
      payload: {
        values: [null, true, "ok", { finite: 1.5 }],
        nested: { right: 2, left: 1 },
        phase: "continue",
      },
      idempotencyKey: "decision-1",
      tool: "agent",
      platform: "web",
      actor: "agent",
      type: "decision",
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
      const journal = await RunJournal.create(projectRoot, "run-1", fixedNow);
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
    const journal = await RunJournal.create(projectRoot, "run-1", fixedNow);
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
