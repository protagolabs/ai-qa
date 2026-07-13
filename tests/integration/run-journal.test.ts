import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { RunJournal } from "../../src/core/runs/journal.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";
import type { ProjectConfig } from "../../src/core/config/schema.js";
import { startExploratoryRun } from "../../src/services/run-protocol/start-exploratory-run.js";
import { initializeProject } from "../../src/services/initialization/initialize-project.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { createCapturedCli } from "../helpers/cli-context.js";

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

describe("RunJournal", () => {
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
      payload: { phase: "started" },
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
      type: "run",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "start-run-1",
      payload: { phase: "started", nested: { left: 1, right: 2 } },
      relatedIds: [],
    });

    await expect(
      journal.append({
        relatedIds: [],
        payload: { nested: { right: 2, left: 1 }, phase: "finished" },
        idempotencyKey: "start-run-1",
        tool: "ai-qa",
        platform: "web",
        actor: "ai-qa",
        type: "run",
      }),
    ).rejects.toMatchObject({ code: "event.idempotency_conflict" });
  });
});

describe("RunRepository", () => {
  it("creates work orders exclusively and detects later tampering", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-repository-"));
    const workOrder = createExploratoryWorkOrder({
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
      code: "EEXIST",
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
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-run-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    await initializeProject({ projectRoot, aiQaHome, config });

    await expect(
      startExploratoryRun({
        projectRoot,
        payload: {
          ...readyPayload,
          readiness: { ...readyPayload.readiness, status: "not_ready" },
        },
        now: () => new Date("2026-07-13T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "doctor.not_ready" });
  });

  it("starts through the trusted CLI and emits the immutable work order", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-cli-"));
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-run-home-"));
    await confirmProjectTrust({
      projectRoot,
      aiQaHome,
      confirmed: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    await initializeProject({ projectRoot, aiQaHome, config });
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () => Promise.resolve(JSON.stringify(readyPayload)),
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
    const workOrder = JSON.parse(captured.stdout.join("")) as {
      runId: string;
      projectId: string;
      startedAt: string;
    };
    expect(workOrder).toMatchObject({
      projectId: "sample-web",
      startedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(
      await readFile(
        join(projectRoot, ".ai-qa", "runs", workOrder.runId, "work-order.json"),
        "utf8",
      ),
    ).toBe(JSON.stringify(workOrder));
  });
});
