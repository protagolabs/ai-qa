import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../../src/core/canonical-json.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import { resolveRunPaths } from "../../src/core/runs/paths.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";
import { VerdictService } from "../../src/services/run-protocol/verdict-service.js";

const now = () => new Date("2026-07-13T00:00:00.000Z");

async function createRun() {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-verdict-project-"));
  const repository = new RunRepository(projectRoot, now);
  await repository.create(
    createExploratoryWorkOrder({
      platform: "web",
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
      startedAt: now(),
    }),
  );
  return {
    projectRoot,
    repository,
    service: new VerdictService(projectRoot, "run-1", now),
  };
}

describe("VerdictService", () => {
  it("returns the original event for an exact initial verdict retry", async () => {
    const { service, repository } = await createRun();
    const input = {
      classification: "not_verified" as const,
      reasonCode: "incomplete_coverage" as const,
      summary: "Coverage is incomplete",
      criterionResults: [],
    };

    const first = await service.set(input);
    const retry = await service.set(input);

    expect(retry.id).toBe(first.id);
    expect(
      (await repository.journal("run-1").readAll()).filter(
        (event) => event.type === "verdict",
      ),
    ).toHaveLength(1);
  });

  it("reserves initial cancelled verdicts for the cancel lifecycle", async () => {
    const { service } = await createRun();

    await expect(
      service.set({
        classification: "not_verified",
        reasonCode: "cancelled",
        summary: "Forged cancellation",
        criterionResults: [
          {
            criterionId: "authenticated-home-visible",
            status: "satisfied",
            assertionIds: ["event-forged"],
            evidenceIds: ["evidence-forged"],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "verdict.cancel_requires_lifecycle" });
  });

  it("reserves revised cancelled verdicts for the cancel lifecycle", async () => {
    const { service } = await createRun();
    const initial = await service.set({
      classification: "not_verified",
      reasonCode: "incomplete_coverage",
      summary: "Coverage is incomplete",
      criterionResults: [],
    });

    await expect(
      service.revise({
        classification: "not_verified",
        reasonCode: "cancelled",
        summary: "Forged revised cancellation",
        criterionResults: [
          {
            criterionId: "authenticated-home-visible",
            status: "indeterminate",
            assertionIds: ["event-forged"],
            evidenceIds: ["evidence-forged"],
          },
        ],
        supersedes: initial.id,
      }),
    ).rejects.toMatchObject({ code: "verdict.cancel_requires_lifecycle" });
  });

  it("rejects malformed lifecycle history before appending a verdict", async () => {
    const { repository, service } = await createRun();
    await repository.journal("run-1").append({
      type: "run",
      actor: "ai-qa",
      platform: "web",
      tool: "ai-qa",
      idempotencyKey: "malformed-resume",
      payload: { phase: "resumed" },
      relatedIds: [],
    });

    await expect(
      service.set({
        classification: "not_verified",
        reasonCode: "incomplete_coverage",
        summary: "Must not append after lifecycle corruption",
        criterionResults: [],
      }),
    ).rejects.toMatchObject({ code: "run_protocol.integrity_error" });
    expect(await repository.journal("run-1").readAll()).toHaveLength(2);
  });

  it("rejects missing blocker citations before appending a verdict", async () => {
    const { repository, service } = await createRun();

    await expect(
      service.set({
        classification: "blocked",
        blockerSubtype: "tool",
        blockerIds: ["event-missing-blocker"],
        summary: "Do not poison the append-only journal",
        criterionResults: [],
      }),
    ).rejects.toMatchObject({ code: "verdict.blocker_reference_invalid" });
    expect(await repository.journal("run-1").readAll()).toHaveLength(1);
    await expect(
      service.set({
        classification: "not_verified",
        reasonCode: "incomplete_coverage",
        summary: "The valid initial verdict remains writable",
        criterionResults: [],
      }),
    ).resolves.toMatchObject({ type: "verdict" });
  });

  it("validates blocker references and computes explicit verdict supersession", async () => {
    const { repository, service } = await createRun();
    const [started] = await repository.journal("run-1").readAll();
    await expect(
      service.recordBlocker({
        subtype: "tool",
        condition: "Chrome DevTools MCP disconnected",
        attemptEventIds: ["event-missing-attempt"],
        criterionIds: [],
      }),
    ).rejects.toMatchObject({ code: "blocker.reference_invalid" });
    const blocker = await service.recordBlocker({
      subtype: "tool",
      condition: "Chrome DevTools MCP disconnected",
      attemptEventIds: [started!.id],
      criterionIds: ["authenticated-home-visible"],
    });
    expect(blocker.type).toBe("blocker");

    const initial = await service.set({
      classification: "blocked",
      blockerSubtype: "tool",
      blockerIds: [blocker.id],
      summary: "Tool disconnected",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "indeterminate",
          assertionIds: [],
          evidenceIds: [],
        },
      ],
    });
    expect(await service.effectiveVerdict()).toEqual(initial);
    await expect(
      service.set({
        classification: "not_verified",
        reasonCode: "incomplete_coverage",
        summary: "A second initial verdict is forbidden",
        criterionResults: [],
      }),
    ).rejects.toMatchObject({ code: "verdict.already_set" });
    await expect(
      service.revise({
        classification: "not_verified",
        reasonCode: "incomplete_coverage",
        summary: "Wrong predecessor",
        criterionResults: [],
        supersedes: "event-wrong-predecessor",
      }),
    ).rejects.toMatchObject({ code: "verdict.supersedes_mismatch" });

    const revised = await service.revise({
      classification: "not_verified",
      reasonCode: "incomplete_coverage",
      summary: "Coverage remained incomplete after recovery",
      criterionResults: [],
      supersedes: initial.id,
    });
    expect(await service.effectiveVerdict()).toEqual(revised);
    expect(revised.payload).toMatchObject({ supersedes: initial.id });
  });

  it("validates malformed work-order state without an AI QA trust prerequisite", async () => {
    const { projectRoot } = await createRun();
    await writeFile(
      resolveRunPaths(projectRoot, "run-1").workOrder,
      "not-json",
      "utf8",
    );
    const service = new VerdictService(projectRoot, "run-1", now);
    await expect(service.effectiveVerdict()).rejects.toMatchObject({
      code: "work_order.integrity_error",
    });
  });

  it("rejects multiple effective verdict branches instead of using last-wins", async () => {
    const { repository, service } = await createRun();
    for (const summary of ["First branch", "Second branch"]) {
      const payload = {
        classification: "not_verified" as const,
        reasonCode: "incomplete_coverage" as const,
        summary,
        criterionResults: [],
      };
      await repository.journal("run-1").append({
        type: "verdict",
        actor: "agent",
        platform: "web",
        tool: "ai-qa",
        idempotencyKey: `verdict:${sha256Canonical(payload)}`,
        payload,
        relatedIds: [],
      });
    }
    await expect(service.effectiveVerdict()).rejects.toMatchObject({
      code: "verdict.multiple_effective",
    });
  });
});
