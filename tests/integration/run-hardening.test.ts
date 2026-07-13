import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
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
import { initializeProject } from "../../src/services/initialization/initialize-project.js";
import { startExploratoryRun } from "../../src/services/run-protocol/start-exploratory-run.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { createCapturedCli } from "../helpers/cli-context.js";

const fixedNow = () => new Date("2026-07-13T00:00:00.000Z");

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

async function initializeTrustedProject(): Promise<{
  projectRoot: string;
  aiQaHome: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-hardening-project-"));
  const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-hardening-home-"));
  await confirmProjectTrust({
    projectRoot,
    aiQaHome,
    confirmed: true,
    now: fixedNow(),
  });
  await initializeProject({ projectRoot, aiQaHome, config });
  return { projectRoot, aiQaHome };
}

describe("run path confinement", () => {
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

describe("trusted exploratory start boundary", () => {
  it("rejects an untrusted direct service call before parsing project config", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-untrusted-service-"),
    );
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-untrusted-home-"));
    await mkdir(join(projectRoot, ".ai-qa"), { recursive: true });
    await writeFile(join(projectRoot, ".ai-qa", "config.yaml"), "invalid: [");

    await expect(
      startExploratoryRun({
        projectRoot,
        aiQaHome,
        payload: readyPayload,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "trust.not_trusted" });
    await expectMissing(join(projectRoot, ".ai-qa", "runs"));
  });

  it("rejects an untrusted CLI start without creating run state", async () => {
    const { projectRoot } = await initializeTrustedProject();
    const untrustedHome = await mkdtemp(
      join(tmpdir(), "ai-qa-untrusted-home-"),
    );
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: untrustedHome },
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
    ).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: { code: "trust.not_trusted" },
    });
    expect(await readdir(join(projectRoot, ".ai-qa", "runs"))).toEqual([]);
  });

  it.each([
    ["kind", "regression"],
    ["platform", "ios"],
    ["execution", "ci"],
  ])(
    "rejects unsupported %s without creating run state",
    async (option, value) => {
      const { projectRoot, aiQaHome } = await initializeTrustedProject();
      const args = {
        kind: "exploratory",
        platform: "web",
        execution: "local",
        [option]: value,
      };
      const captured = createCapturedCli({
        cwd: projectRoot,
        env: { AI_QA_HOME: aiQaHome },
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
      payload: { phase: "continue", nested: { left: 1, right: 2 } },
      relatedIds: ["one", "two"],
    });
    const retry = await journal.append({
      relatedIds: ["one", "two"],
      payload: { nested: { right: 2, left: 1 }, phase: "continue" },
      idempotencyKey: "decision-1",
      tool: "agent",
      platform: "web",
      actor: "agent",
      type: "decision",
    });

    expect(retry.id).toBe(first.id);
    expect(await journal.readAll()).toHaveLength(1);
  });
});
