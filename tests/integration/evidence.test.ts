import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProgram, runCli } from "../../src/cli/program.js";
import { EvidenceRepository } from "../../src/core/evidence/repository.js";
import { actionPayloadSchema } from "../../src/core/runs/event-payloads.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { confirmProjectTrust } from "../../src/services/trust/confirm-project-trust.js";
import { createCapturedCli } from "../helpers/cli-context.js";

const fixedNow = () => new Date("2026-07-13T00:00:00.000Z");

async function createTrustedRun(selectedAiQaHome?: string): Promise<{
  projectRoot: string;
  aiQaHome: string;
  runRepository: RunRepository;
  captureActionId: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-project-"));
  const aiQaHome =
    selectedAiQaHome ?? (await mkdtemp(join(tmpdir(), "ai-qa-evidence-home-")));
  await confirmProjectTrust({
    projectRoot,
    aiQaHome,
    confirmed: true,
    now: fixedNow(),
  });
  const runRepository = new RunRepository(projectRoot, fixedNow);
  await runRepository.create(
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
      startedAt: fixedNow(),
    }),
  );
  const journal = runRepository.journal("run-1");
  const planned = await journal.append({
    type: "action",
    actor: "agent",
    platform: "web",
    tool: "chrome-devtools-mcp",
    idempotencyKey: "plan-capture-home",
    payload: {
      phase: "planned",
      kind: "evidence-capture",
      intent: "Capture the authenticated home",
      stepId: "step-home",
      target: { description: "Authenticated home" },
    },
    relatedIds: [],
  });
  await journal.append({
    type: "action",
    actor: "agent",
    platform: "web",
    tool: "chrome-devtools-mcp",
    idempotencyKey: `complete:${planned.id}`,
    payload: {
      phase: "completed",
      actionId: planned.id,
      toolResult: { summary: "Screenshot captured" },
    },
    relatedIds: [planned.id],
  });
  return {
    projectRoot,
    aiQaHome,
    runRepository,
    captureActionId: planned.id,
  };
}

describe("actionPayloadSchema", () => {
  it("accepts strict planned and JSON-safe terminal action payloads", () => {
    expect(
      actionPayloadSchema.parse({
        phase: "planned",
        kind: "evidence-capture",
        intent: "Capture the authenticated home",
        stepId: "step-home",
        target: { description: "Authenticated home", selector: "main" },
      }),
    ).toMatchObject({ phase: "planned", kind: "evidence-capture" });
    expect(
      actionPayloadSchema.parse({
        phase: "completed",
        actionId: "event-capture-action",
        toolResult: { summary: "Screenshot captured", data: { bytes: 42 } },
      }),
    ).toMatchObject({ phase: "completed" });

    expect(() =>
      actionPayloadSchema.parse({
        phase: "planned",
        kind: "evidence-capture",
        intent: "Capture",
        stepId: "step-home",
        target: { description: "Home" },
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      actionPayloadSchema.parse({
        phase: "unknown",
        actionId: "event-capture-action",
        toolResult: {
          summary: "Unknown result",
          data: new Date("2026-07-13T00:00:00.000Z"),
        },
      }),
    ).toThrow();
  });
});

describe("EvidenceRepository", () => {
  it("copies raw evidence, hashes it, and detects later tampering", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-"));
    const source = join(projectRoot, "screen.png");
    await writeFile(source, Buffer.from("original-image"));
    const repository = new EvidenceRepository(
      projectRoot,
      "run-1",
      () => new Date("2026-07-13T00:00:00.000Z"),
    );

    const record = await repository.registerRaw({
      sourcePath: source,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-capture-action",
      idempotencyKey: "capture-home",
    });

    expect(record.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      await readFile(join(projectRoot, record.projectRelativePath), "utf8"),
    ).toBe("original-image");
    await writeFile(join(projectRoot, record.projectRelativePath), "tampered");
    await expect(repository.verifyAll()).rejects.toMatchObject({
      code: "evidence.integrity_error",
      details: {
        evidenceId: record.id,
        expectedHash: record.contentHash,
        actualHash: `sha256:${createHash("sha256")
          .update("tampered")
          .digest("hex")}`,
      },
    });
  });

  it("rejects an indexed symlink that escapes the run evidence root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-path-"));
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const repository = new EvidenceRepository(projectRoot, "run-1", fixedNow);
    const record = await repository.registerRaw({
      sourcePath: source,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-capture-action",
      idempotencyKey: "capture-home",
    });
    const stored = join(projectRoot, record.projectRelativePath);
    const outside = join(projectRoot, "outside.png");
    await writeFile(outside, "original-image");
    await rm(stored);
    await symlink(outside, stored);

    await expect(repository.verifyAll()).rejects.toMatchObject({
      code: "evidence.integrity_error",
    });
  });

  it("does not let an idempotent retry hide tampered copied evidence", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-retry-"));
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const repository = new EvidenceRepository(projectRoot, "run-1", fixedNow);
    const input = {
      sourcePath: source,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal" as const,
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-capture-action",
      idempotencyKey: "capture-home",
    };
    const record = await repository.registerRaw(input);
    await writeFile(join(projectRoot, record.projectRelativePath), "tampered");

    await expect(repository.registerRaw(input)).rejects.toMatchObject({
      code: "evidence.integrity_error",
    });
  });

  it("rejects a changed source on an idempotent retry", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-source-"));
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const repository = new EvidenceRepository(projectRoot, "run-1", fixedNow);
    const input = {
      sourcePath: source,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal" as const,
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-capture-action",
      idempotencyKey: "capture-home",
    };
    await repository.registerRaw(input);
    await writeFile(source, "changed-image");

    await expect(repository.registerRaw(input)).rejects.toMatchObject({
      code: "evidence.idempotency_conflict",
    });
  });

  it.each([
    ["malformed JSON", () => "{"],
    [
      "unknown fields",
      (line: string) => {
        const value = JSON.parse(line) as Record<string, unknown>;
        value.unexpected = true;
        return JSON.stringify(value);
      },
    ],
    [
      "path escape",
      (line: string) => {
        const value = JSON.parse(line) as Record<string, unknown>;
        value.projectRelativePath = "../outside.png";
        return JSON.stringify(value);
      },
    ],
  ])("normalizes %s index integrity failures", async (_name, mutate) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-index-"));
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const repository = new EvidenceRepository(projectRoot, "run-1", fixedNow);
    await repository.registerRaw({
      sourcePath: source,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-capture-action",
      idempotencyKey: "capture-home",
    });
    const index = join(
      projectRoot,
      ".ai-qa",
      "evidence",
      "run-1",
      "index.jsonl",
    );
    await writeFile(
      index,
      `${mutate((await readFile(index, "utf8")).trim())}\n`,
    );

    await expect(repository.verifyAll()).rejects.toMatchObject({
      code: "evidence.integrity_error",
    });
  });

  it("normalizes a missing indexed file as an integrity failure", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-evidence-missing-"),
    );
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const repository = new EvidenceRepository(projectRoot, "run-1", fixedNow);
    const record = await repository.registerRaw({
      sourcePath: source,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-capture-action",
      idempotencyKey: "capture-home",
    });
    await rm(join(projectRoot, record.projectRelativePath));

    await expect(repository.verifyAll()).rejects.toMatchObject({
      code: "evidence.integrity_error",
    });
  });

  it("removes only its copied file when validation fails before indexing", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-evidence-cleanup-"),
    );
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const repository = new EvidenceRepository(projectRoot, "run-1", fixedNow);

    await expect(
      repository.registerRaw({
        sourcePath: source,
        mediaType: "",
        sourceTool: "chrome-devtools-mcp",
        sensitivity: "internal",
        evidenceKinds: ["post-action-screenshot"],
        captureActionId: "event-capture-action",
        idempotencyKey: "capture-home",
      }),
    ).rejects.toBeDefined();
    const evidenceRoot = join(projectRoot, ".ai-qa", "evidence", "run-1");
    expect(await readdir(join(evidenceRoot, "files"))).toEqual([]);
    expect(await readFile(join(evidenceRoot, "index.jsonl"), "utf8")).toBe("");
  });

  it("rejects unsafe run IDs before creating evidence paths", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-run-id-"));

    expect(
      () => new EvidenceRepository(projectRoot, "../outside", fixedNow),
    ).toThrow();
    await expect(access(join(projectRoot, ".ai-qa"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("registerEvidence", () => {
  it("repairs an indexed registration by appending one typed evidence event", async () => {
    const { projectRoot, aiQaHome, runRepository } = await createTrustedRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, Buffer.from("original-image"));
    const planned = (await runRepository.journal("run-1").readAll()).find(
      (event) =>
        event.type === "action" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        !Array.isArray(event.payload) &&
        event.payload.phase === "planned",
    );
    expect(planned).toBeDefined();
    if (planned === undefined) throw new Error("missing planned action");

    const payload = {
      sourcePath: source,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal" as const,
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: planned.id,
      idempotencyKey: "capture-home",
    };
    const indexed = await new EvidenceRepository(
      projectRoot,
      "run-1",
      fixedNow,
    ).registerRaw(payload);

    const registered = await registerEvidence({
      projectRoot,
      aiQaHome,
      runId: "run-1",
      payload,
      criterionIds: ["authenticated-home-visible"],
      observationIds: [],
      now: fixedNow,
    });
    const retried = await registerEvidence({
      projectRoot,
      aiQaHome,
      runId: "run-1",
      payload,
      criterionIds: ["authenticated-home-visible"],
      observationIds: [],
      now: fixedNow,
    });

    expect(registered).toEqual(indexed);
    expect(retried).toEqual(indexed);
    const evidenceEvents = (
      await runRepository.journal("run-1").readAll()
    ).filter((event) => event.type === "evidence");
    expect(evidenceEvents).toHaveLength(1);
    expect(evidenceEvents[0]?.payload).toMatchObject({
      ...indexed,
      criterionIds: ["authenticated-home-visible"],
      observationIds: [],
    });
  });

  it("enforces machine trust before reading malformed run state", async () => {
    const projectRoot = await mkdtemp(
      join(tmpdir(), "ai-qa-evidence-untrusted-"),
    );
    const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-evidence-home-"));
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const runRoot = join(projectRoot, ".ai-qa", "runs", "run-1");
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "work-order.json"), "{");

    await expect(
      registerEvidence({
        projectRoot,
        aiQaHome,
        runId: "run-1",
        payload: {
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId: "event-capture-action",
          idempotencyKey: "capture-home",
        },
        criterionIds: [],
        observationIds: [],
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "trust.not_trusted" });
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a completed interaction as an evidence capture action", async () => {
    const { projectRoot, aiQaHome, runRepository } = await createTrustedRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const journal = runRepository.journal("run-1");
    const interaction = await journal.append({
      type: "action",
      actor: "agent",
      platform: "web",
      tool: "chrome-devtools-mcp",
      idempotencyKey: "plan-click-home",
      payload: {
        phase: "planned",
        kind: "interaction",
        intent: "Open home",
        stepId: "step-home",
        target: { description: "Home link" },
      },
      relatedIds: [],
    });
    await journal.append({
      type: "action",
      actor: "agent",
      platform: "web",
      tool: "chrome-devtools-mcp",
      idempotencyKey: `complete:${interaction.id}`,
      payload: {
        phase: "completed",
        actionId: interaction.id,
        toolResult: { summary: "Home opened" },
      },
      relatedIds: [interaction.id],
    });

    await expect(
      registerEvidence({
        projectRoot,
        aiQaHome,
        runId: "run-1",
        payload: {
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId: interaction.id,
          idempotencyKey: "capture-from-interaction",
        },
        criterionIds: [],
        observationIds: [],
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "evidence.capture_action_invalid" });
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("evidence add CLI", () => {
  it("resolves a relative source and registers it through the trusted command", async () => {
    const { projectRoot, aiQaHome, captureActionId } = await createTrustedRun();
    await writeFile(join(projectRoot, "screen.png"), "original-image");
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: { AI_QA_HOME: aiQaHome },
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            mediaType: "image/png",
            sourceTool: "chrome-devtools-mcp",
            sensitivity: "internal",
            evidenceKinds: ["post-action-screenshot"],
            captureActionId,
            idempotencyKey: "capture-home-cli",
            criterionIds: ["authenticated-home-visible"],
            observationIds: [],
          }),
        ),
    });

    const exitCode = await runCli(
      [
        "evidence",
        "add",
        "--run",
        "run-1",
        "--file",
        "screen.png",
        "--stdin-json",
        "--project",
        projectRoot,
      ],
      captured.context,
    );

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
      runId: "run-1",
      mediaType: "image/png",
      captureActionId,
      idempotencyKey: "capture-home-cli",
    });
  });

  it("uses the default machine home and rejects another project's .ai-qa source", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ai-qa-cli-home-"));
    const aiQaHome = join(homeDir, ".ai-qa");
    const { projectRoot, captureActionId } = await createTrustedRun(aiQaHome);
    const otherProject = await mkdtemp(join(tmpdir(), "ai-qa-other-project-"));
    const otherState = join(otherProject, ".ai-qa");
    await mkdir(otherState, { recursive: true });
    const source = join(otherState, "screen.png");
    await writeFile(source, "original-image");
    const captured = createCapturedCli({
      cwd: projectRoot,
      env: {},
      homeDir,
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            mediaType: "image/png",
            sourceTool: "chrome-devtools-mcp",
            sensitivity: "internal",
            evidenceKinds: ["post-action-screenshot"],
            captureActionId,
            idempotencyKey: "capture-other-state",
            criterionIds: [],
            observationIds: [],
          }),
        ),
    });

    expect(
      await runCli(
        [
          "evidence",
          "add",
          "--run",
          "run-1",
          "--file",
          source,
          "--stdin-json",
          "--project",
          projectRoot,
        ],
        captured.context,
      ),
    ).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: { code: "evidence.source_forbidden" },
    });
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not expose a generic event command", () => {
    const captured = createCapturedCli();

    expect(
      createProgram(captured.context)
        .commands.map((command) => command.name())
        .includes("event"),
    ).toBe(false);
  });
});
