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
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { createProgram, runCli } from "../../src/cli/program.js";
import { sha256Canonical } from "../../src/core/canonical-json.js";
import {
  EvidenceRepository,
  registerRawEvidenceInputSchema,
} from "../../src/core/evidence/repository.js";
import { actionPayloadSchema } from "../../src/core/runs/event-payloads.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";
import { WEB_CONTROLLER } from "../../src/core/tools.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { createCapturedCli } from "../helpers/cli-context.js";

const fixedNow = () => new Date("2026-07-13T00:00:00.000Z");

async function createRun(): Promise<{
  projectRoot: string;
  runRepository: RunRepository;
  captureActionId: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-project-"));
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
  it("rejects an unconfigured evidence source tool", () => {
    expect(
      registerRawEvidenceInputSchema.safeParse({
        sourcePath: "/tmp/screen.png",
        mediaType: "image/png",
        sourceTool: "fake-browser",
        sensitivity: "internal",
        evidenceKinds: ["post-action-screenshot"],
        captureActionId: "event-capture",
        idempotencyKey: "fake-source",
      }).success,
    ).toBe(false);
  });

  it("persists newline-terminated replacements across repository instances", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-"));
    const firstSource = join(projectRoot, "first.png");
    const secondSource = join(projectRoot, "second.png");
    await writeFile(firstSource, "first");
    await writeFile(secondSource, "second");
    const repository = new EvidenceRepository(projectRoot, "run-1", fixedNow);
    await repository.registerRaw({
      sourcePath: firstSource,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-capture-first",
      idempotencyKey: "first",
    });
    await repository.registerRaw({
      sourcePath: secondSource,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-capture-second",
      idempotencyKey: "second",
    });
    const path = join(
      projectRoot,
      ".ai-qa",
      "evidence",
      "run-1",
      "index.jsonl",
    );
    const reopened = new EvidenceRepository(projectRoot, "run-1", fixedNow);

    expect(await readFile(path, "utf8")).toMatch(/[^\n]\n$/u);
    await expect(reopened.readAll()).resolves.toHaveLength(2);
  });

  it("waits for a realistic evidence critical section instead of failing after 350 ms", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-lock-"));
    const firstSource = join(projectRoot, "first.png");
    const secondSource = join(projectRoot, "second.png");
    await writeFile(firstSource, "first");
    await writeFile(secondSource, "second");
    const repository = new EvidenceRepository(
      projectRoot,
      "run-lock",
      fixedNow,
    );
    await repository.registerRaw({
      sourcePath: firstSource,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-capture-first",
      idempotencyKey: "first",
    });
    const indexPath = join(
      projectRoot,
      ".ai-qa",
      "evidence",
      "run-lock",
      "index.jsonl",
    );
    const release = await lockfile.lock(indexPath, { realpath: false });
    const registration = repository.registerRaw({
      sourcePath: secondSource,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: "event-capture-second",
      idempotencyKey: "second",
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await release();

    await expect(registration).resolves.toMatchObject({
      idempotencyKey: "second",
    });
  });

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
      sourceTool: WEB_CONTROLLER,
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
      sourceTool: WEB_CONTROLLER,
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
    const repository = new EvidenceRepository(
      projectRoot,
      "run-1",
      () => new Date(Number.NaN),
    );

    await expect(
      repository.registerRaw({
        sourcePath: source,
        mediaType: "image/png",
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

  it.each([
    ["unsafe evidence ID", { id: "../evidence" }],
    ["unsafe capture action ID", { captureActionId: "../event" }],
    ["unsafe parent evidence ID", { parentEvidenceId: "../parent" }],
    ["absolute path", { projectRelativePath: "/tmp/evidence.png" }],
    [
      "backslash path",
      {
        projectRelativePath:
          ".ai-qa\\evidence\\run-1\\files\\evidence-safe.png",
      },
    ],
    [
      "empty path segment",
      {
        projectRelativePath: ".ai-qa/evidence/run-1/files//evidence-safe.png",
      },
    ],
    [
      "dot path segment",
      {
        projectRelativePath: ".ai-qa/evidence/run-1/files/./evidence-safe.png",
      },
    ],
    [
      "traversing path",
      {
        projectRelativePath:
          ".ai-qa/evidence/run-1/files/../outside-evidence.png",
      },
    ],
    [
      "cross-run path",
      {
        projectRelativePath:
          ".ai-qa/evidence/run-2/files/evidence-safe-screen.png",
      },
    ],
    [
      "cross-evidence path",
      {
        projectRelativePath:
          ".ai-qa/evidence/run-1/files/evidence-other-screen.png",
      },
    ],
  ])("rejects a structurally %s from readAll", async (_name, mutation) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-safe-"));
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
    const record = JSON.parse((await readFile(index, "utf8")).trim()) as Record<
      string,
      unknown
    >;
    await writeFile(index, `${JSON.stringify({ ...record, ...mutation })}\n`);

    await expect(repository.readAll()).rejects.toBeDefined();
    await expect(repository.verifyAll()).rejects.toMatchObject({
      code: "evidence.integrity_error",
    });
  });

  it.each([
    ["unsafe action ID", { captureActionId: "../event" }],
    ["unknown input field", { unexpected: true }],
  ])("rejects %s before creating evidence storage", async (_name, mutation) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-evidence-input-"));
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const repository = new EvidenceRepository(projectRoot, "run-1", fixedNow);

    await expect(
      repository.registerRaw({
        sourcePath: source,
        mediaType: "image/png",
        sourceTool: "chrome-devtools-mcp",
        sensitivity: "internal",
        evidenceKinds: ["post-action-screenshot"],
        captureActionId: "event-capture-action",
        idempotencyKey: "capture-home",
        ...mutation,
      }),
    ).rejects.toBeDefined();
    await expect(access(join(projectRoot, ".ai-qa"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["evidence root", "evidence", "internal"],
    ["run root", "run", "internal"],
    ["files root", "files", "internal"],
    ["evidence root", "evidence", "outside"],
    ["run root", "run", "outside"],
    ["files root", "files", "outside"],
  ] as const)(
    "rejects a symlinked %s with an %s target before touching the target",
    async (_name, component, targetLocation) => {
      const projectRoot = await mkdtemp(
        join(tmpdir(), "ai-qa-evidence-root-link-"),
      );
      const source = join(projectRoot, "screen.png");
      await writeFile(source, "original-image");
      const evidenceRoot = join(projectRoot, ".ai-qa", "evidence");
      const runRoot = join(evidenceRoot, "run-1");
      const linkPath =
        component === "evidence"
          ? evidenceRoot
          : component === "run"
            ? runRoot
            : join(runRoot, "files");
      const target =
        targetLocation === "outside"
          ? await mkdtemp(join(tmpdir(), "ai-qa-evidence-link-target-"))
          : component === "evidence"
            ? join(projectRoot, "alternate-evidence")
            : component === "run"
              ? join(evidenceRoot, "alternate-run")
              : join(runRoot, "alternate-files");
      await mkdir(dirname(linkPath), { recursive: true });
      await mkdir(target, { recursive: true });
      await symlink(target, linkPath);
      const repository = new EvidenceRepository(projectRoot, "run-1", fixedNow);

      await expect(
        repository.registerRaw({
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId: "event-capture-action",
          idempotencyKey: "capture-home",
        }),
      ).rejects.toMatchObject({ code: "evidence.integrity_error" });
      expect(await readdir(target)).toEqual([]);
    },
  );
});

describe("registerEvidence", () => {
  it("preserves run.not_found when evidence targets a missing run", async () => {
    const { projectRoot, captureActionId } = await createRun();
    const source = join(projectRoot, "missing-run.png");
    await writeFile(source, Buffer.from("missing-run-image"));

    await expect(
      registerEvidence({
        projectRoot,
        runId: "run-missing",
        payload: {
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId,
          idempotencyKey: "missing-run-evidence",
        },
        criterionIds: [],
        observationIds: [],
        now: fixedNow,
      }),
    ).rejects.toMatchObject({
      code: "run.not_found",
      message: "Run does not exist",
      details: { runId: "run-missing" },
    });
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence", "run-missing")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a missing journal in an existing run as partial corruption", async () => {
    const { projectRoot, captureActionId } = await createRun();
    const source = join(projectRoot, "partial-run.png");
    await writeFile(source, Buffer.from("partial-run-image"));
    await rm(join(projectRoot, ".ai-qa", "runs", "run-1", "events.jsonl"));

    await expect(
      registerEvidence({
        projectRoot,
        runId: "run-1",
        payload: {
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId,
          idempotencyKey: "partial-run-evidence",
        },
        criterionIds: [],
        observationIds: [],
        now: fixedNow,
      }),
    ).rejects.toMatchObject({
      code: "journal.integrity_error",
      message: "Run journal integrity verification failed",
      details: { runId: "run-1" },
    });
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence", "run-1")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects forged protocol metadata before mutating evidence storage", async () => {
    const { projectRoot, captureActionId, runRepository } =
      await createRun();
    const source = join(projectRoot, "forged-history.png");
    await writeFile(source, Buffer.from("forged-history-image"));
    const decisionPayload = {
      kind: "semantic" as const,
      rationale: "Schema-valid payload with forged event metadata",
      relatedIds: [],
    };
    const journal = runRepository.journal("run-1");
    await journal.append({
      type: "decision",
      actor: "ai-qa",
      platform: "web",
      tool: "chrome-devtools-mcp",
      idempotencyKey: `decision:${sha256Canonical(decisionPayload)}`,
      payload: decisionPayload,
      relatedIds: [captureActionId],
    });
    const journalPath = join(
      projectRoot,
      ".ai-qa",
      "runs",
      "run-1",
      "events.jsonl",
    );
    const journalBefore = await readFile(journalPath, "utf8");
    const evidenceRoot = join(projectRoot, ".ai-qa", "evidence", "run-1");

    await expect(
      registerEvidence({
        projectRoot,
        runId: "run-1",
        payload: {
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId,
          idempotencyKey: "forged-history-evidence",
        },
        criterionIds: ["authenticated-home-visible"],
        observationIds: [],
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
    await expect(readFile(journalPath, "utf8")).resolves.toBe(journalBefore);
    await expect(access(evidenceRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("repairs an indexed registration by appending one typed evidence event", async () => {
    const { projectRoot, runRepository } = await createRun();
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
      sourceTool: WEB_CONTROLLER,
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
      runId: "run-1",
      payload,
      criterionIds: ["authenticated-home-visible"],
      observationIds: [],
      now: fixedNow,
    });
    const retried = await registerEvidence({
      projectRoot,
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

  it("rejects duplicate index records after an idempotent retry", async () => {
    const { projectRoot, captureActionId, runRepository } =
      await createRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, Buffer.from("original-image"));
    const input = {
      projectRoot,
      runId: "run-1",
      payload: {
        sourcePath: source,
        mediaType: "image/png",
        sourceTool: WEB_CONTROLLER,
        sensitivity: "internal" as const,
        evidenceKinds: ["post-action-screenshot"],
        captureActionId,
        idempotencyKey: "capture-duplicate-retry",
      },
      criterionIds: ["authenticated-home-visible"],
      observationIds: [],
      now: fixedNow,
    };
    await registerEvidence(input);
    const indexPath = join(
      projectRoot,
      ".ai-qa",
      "evidence",
      "run-1",
      "index.jsonl",
    );
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, `${index}${index}`);

    await expect(registerEvidence(input)).rejects.toMatchObject({
      code: "evidence.integrity_error",
    });
    expect(
      (await runRepository.journal("run-1").readAll()).filter(
        (event) => event.type === "evidence",
      ),
    ).toHaveLength(1);
  });

  it("validates malformed work-order state before mutating evidence storage", async () => {
    const { projectRoot } = await createRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    await writeFile(
      join(projectRoot, ".ai-qa", "runs", "run-1", "work-order.json"),
      "{",
    );

    await expect(
      registerEvidence({
        projectRoot,
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
    ).rejects.toMatchObject({ code: "work_order.integrity_error" });
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a completed interaction as an evidence capture action", async () => {
    const { projectRoot, runRepository } = await createRun();
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

  it("rejects an unknown criterion before creating evidence storage", async () => {
    const { projectRoot, captureActionId } = await createRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");

    await expect(
      registerEvidence({
        projectRoot,
        runId: "run-1",
        payload: {
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId,
          idempotencyKey: "capture-unknown-criterion",
        },
        criterionIds: ["unknown-criterion"],
        observationIds: [],
        now: fixedNow,
      }),
    ).rejects.toBeDefined();
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a dangling observation before creating evidence storage", async () => {
    const { projectRoot, captureActionId } = await createRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");

    await expect(
      registerEvidence({
        projectRoot,
        runId: "run-1",
        payload: {
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId,
          idempotencyKey: "capture-dangling-observation",
        },
        criterionIds: ["authenticated-home-visible"],
        observationIds: ["event-missing-observation"],
        now: fixedNow,
      }),
    ).rejects.toBeDefined();
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a wrong-type observation citation before evidence storage", async () => {
    const { projectRoot, captureActionId } = await createRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");

    await expect(
      registerEvidence({
        projectRoot,
        runId: "run-1",
        payload: {
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId,
          idempotencyKey: "capture-wrong-observation",
        },
        criterionIds: ["authenticated-home-visible"],
        observationIds: [captureActionId],
        now: fixedNow,
      }),
    ).rejects.toBeDefined();
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an invalid typed observation before creating evidence storage", async () => {
    const { projectRoot, captureActionId, runRepository } =
      await createRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const invalidObservation = await runRepository.journal("run-1").append({
      type: "observation",
      actor: "agent",
      platform: "web",
      tool: "chrome-devtools-mcp",
      payload: {
        summary: "Current page",
        state: { url: "https://example.com/home" },
        actionId: captureActionId,
        unexpected: true,
      },
      relatedIds: [captureActionId],
    });

    await expect(
      registerEvidence({
        projectRoot,
        runId: "run-1",
        payload: {
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId,
          idempotencyKey: "capture-invalid-observation",
        },
        criterionIds: ["authenticated-home-visible"],
        observationIds: [invalidObservation.id],
        now: fixedNow,
      }),
    ).rejects.toBeDefined();
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists strict valid criterion and observation citations", async () => {
    const { projectRoot, captureActionId, runRepository } =
      await createRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const journal = runRepository.journal("run-1");
    const observationAction = await journal.append({
      type: "action",
      actor: "agent",
      platform: "web",
      tool: "chrome-devtools-mcp",
      idempotencyKey: "plan-observe-home",
      payload: {
        phase: "planned",
        kind: "observation",
        intent: "Observe the current home",
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
      idempotencyKey: `complete:${observationAction.id}`,
      payload: {
        phase: "completed",
        actionId: observationAction.id,
        toolResult: { summary: "Home observed" },
      },
      relatedIds: [observationAction.id],
    });
    const observation = await journal.append({
      type: "observation",
      actor: "agent",
      platform: "web",
      tool: "chrome-devtools-mcp",
      idempotencyKey: `observation:${observationAction.id}`,
      payload: {
        summary: "Authenticated home is visible",
        state: { url: "https://example.com/home" },
        stepId: "step-home",
        actionId: observationAction.id,
      },
      relatedIds: [observationAction.id],
    });

    const record = await registerEvidence({
      projectRoot,
      runId: "run-1",
      payload: {
        sourcePath: source,
        mediaType: "image/png",
        sourceTool: "chrome-devtools-mcp",
        sensitivity: "internal",
        evidenceKinds: ["post-action-screenshot"],
        captureActionId,
        idempotencyKey: "capture-valid-citations",
      },
      criterionIds: ["authenticated-home-visible"],
      observationIds: [observation.id],
      now: fixedNow,
    });

    const evidenceEvent = (await journal.readAll()).find(
      (event) => event.type === "evidence",
    );
    expect(evidenceEvent?.payload).toMatchObject({
      id: record.id,
      criterionIds: ["authenticated-home-visible"],
      observationIds: [observation.id],
    });
    expect(evidenceEvent?.relatedIds).toEqual([
      captureActionId,
      observation.id,
    ]);
  });

  it("rejects a forged non-evidence idempotency collision before storage", async () => {
    const { projectRoot, captureActionId, runRepository } =
      await createRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    await runRepository.journal("run-1").append({
      type: "decision",
      actor: "agent",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "capture-collision",
      payload: { kind: "semantic", rationale: "Existing decision" },
      relatedIds: [],
    });

    await expect(
      registerEvidence({
        projectRoot,
        runId: "run-1",
        payload: {
          sourcePath: source,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId,
          idempotencyKey: "capture-collision",
        },
        criterionIds: ["authenticated-home-visible"],
        observationIds: [],
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
    await expect(
      access(join(projectRoot, ".ai-qa", "evidence")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("coordinates concurrent same-key registrations into one record and event", async () => {
    const { projectRoot, captureActionId, runRepository } =
      await createRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const input = {
      projectRoot,
      runId: "run-1",
      payload: {
        sourcePath: source,
        mediaType: "image/png",
        sourceTool: WEB_CONTROLLER,
        sensitivity: "internal" as const,
        evidenceKinds: ["post-action-screenshot"],
        captureActionId,
        idempotencyKey: "capture-concurrent",
      },
      criterionIds: ["authenticated-home-visible"],
      observationIds: [],
      now: fixedNow,
    };

    const [first, second] = await Promise.all([
      registerEvidence(input),
      registerEvidence(input),
    ]);

    expect(second).toEqual(first);
    expect(
      (await runRepository.journal("run-1").readAll()).filter(
        (event) => event.type === "evidence",
      ),
    ).toHaveLength(1);
    expect(
      await readdir(join(projectRoot, ".ai-qa", "evidence", "run-1", "files")),
    ).toHaveLength(1);
  });

  it("rejects a non-strict existing evidence event without adding files", async () => {
    const { projectRoot, captureActionId } = await createRun();
    const source = join(projectRoot, "screen.png");
    await writeFile(source, "original-image");
    const input = {
      projectRoot,
      runId: "run-1",
      payload: {
        sourcePath: source,
        mediaType: "image/png",
        sourceTool: WEB_CONTROLLER,
        sensitivity: "internal" as const,
        evidenceKinds: ["post-action-screenshot"],
        captureActionId,
        idempotencyKey: "capture-strict-retry",
      },
      criterionIds: ["authenticated-home-visible"],
      observationIds: [],
      now: fixedNow,
    };
    await registerEvidence(input);
    const eventsPath = join(
      projectRoot,
      ".ai-qa",
      "runs",
      "run-1",
      "events.jsonl",
    );
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const evidenceEvent = events.find((event) => event.type === "evidence");
    if (evidenceEvent === undefined) throw new Error("missing evidence event");
    evidenceEvent.payload = {
      ...(evidenceEvent.payload as Record<string, unknown>),
      unexpected: true,
    };
    await writeFile(
      eventsPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await expect(registerEvidence(input)).rejects.toMatchObject({
      code: "run_protocol.integrity_error",
    });
    expect(
      await readdir(join(projectRoot, ".ai-qa", "evidence", "run-1", "files")),
    ).toHaveLength(1);
  });
});

describe("evidence add CLI", () => {
  it("returns one path-safe run.not_found error for a missing run", async () => {
    const { projectRoot, captureActionId } = await createRun();
    const source = join(projectRoot, "missing-run-cli.png");
    await writeFile(source, Buffer.from("missing-run-cli-image"));
    const captured = createCapturedCli({
      cwd: projectRoot,
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            mediaType: "image/png",
            sourceTool: "chrome-devtools-mcp",
            sensitivity: "internal",
            evidenceKinds: ["post-action-screenshot"],
            captureActionId,
            idempotencyKey: "missing-run-cli-evidence",
            criterionIds: [],
            observationIds: [],
          }),
        ),
    });

    const exitCode = await runCli(
      [
        "evidence",
        "add",
        "--run",
        "run-missing",
        "--file",
        source,
        "--stdin-json",
        "--project",
        projectRoot,
      ],
      captured.context,
    );

    expect(exitCode).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr).toHaveLength(1);
    expect(JSON.parse(captured.stderr[0]!)).toEqual({
      error: {
        code: "run.not_found",
        message: "Run does not exist",
        details: { runId: "run-missing" },
      },
    });
    expect(captured.stderr[0]).not.toContain(projectRoot);
    expect(captured.stderr[0]).not.toContain(source);
    expect(captured.stderr[0]?.toLowerCase()).not.toContain("stack");
    expect(captured.stderr[0]?.toLowerCase()).not.toContain("path");
  });

  it("resolves a relative source and registers it through the host-authorized command", async () => {
    const { projectRoot, captureActionId } = await createRun();
    await writeFile(join(projectRoot, "screen.png"), "original-image");
    const captured = createCapturedCli({
      cwd: projectRoot,
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
    const { projectRoot, captureActionId } = await createRun();
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
