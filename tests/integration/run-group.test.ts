import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { CaseRepository } from "../../src/core/cases/repository.js";
import type { CaseRevision } from "../../src/core/cases/schema.js";
import { resolveRunGroupPaths } from "../../src/core/run-groups/paths.js";
import { RunGroupRepository } from "../../src/core/run-groups/repository.js";
import { runGroupManifestSchema } from "../../src/core/run-groups/schema.js";
import type { Platform } from "../../src/core/platforms/schema.js";
import type { PlatformReadiness } from "../../src/core/readiness/schema.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import { workOrderSchema, type WorkOrder } from "../../src/core/runs/schema.js";
import { cancelRunGroup } from "../../src/services/run-groups/cancel-run-group.js";
import { finishRunGroup } from "../../src/services/run-groups/finish-run-group.js";
import { materializeRunGroup } from "../../src/services/run-groups/materialize-run-group.js";
import { startRunGroup } from "../../src/services/run-groups/start-run-group.js";
import { readRunState } from "../../src/services/run-protocol/read-run-state.js";
import { cancelRun } from "../../src/services/run-protocol/run-lifecycle.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import {
  initializeTestProject,
  projectConfig,
} from "../helpers/project-fixture.js";

const startedAt = new Date("2026-07-17T00:00:00.000Z");
const now = () => startedAt;
const allPlatforms = ["web", "ios-simulator", "android-emulator"] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

function readiness(platform: Platform): PlatformReadiness {
  return {
    platform,
    status: "ready",
    checks: [
      {
        code: `${platform}.ready`,
        status: "pass",
        message: `${platform} is ready`,
        category: "tool",
      },
    ],
  };
}

function readinessByPlatform(platforms: readonly Platform[]) {
  return Object.fromEntries(
    platforms.map((platform) => [platform, readiness(platform)]),
  ) as Partial<Record<Platform, PlatformReadiness>>;
}

async function fixture(platforms: readonly Platform[] = allPlatforms) {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-group-"));
  await initializeTestProject({
    projectRoot,
    config: projectConfig(platforms),
  });
  return { projectRoot, cases: new CaseRepository(projectRoot, now) };
}

function step(platform: Platform) {
  const controller =
    platform === "web"
      ? ("chrome-devtools-mcp" as const)
      : platform === "ios-simulator"
        ? ("pepper" as const)
        : ("appium" as const);
  return {
    id: `step-${platform.replaceAll("-", "")}`,
    sourceActionId: `event-source-${platform}`,
    intent: `Exercise ${platform}`,
    tool: controller,
    target: {
      description: `${platform} target`,
      stability: "stable" as const,
      stabilityRationale: "Fixture-owned stable target",
    },
    expectedState: `${platform} expected state`,
    assertionStrategy: `Observe ${platform}`,
    evidenceCheckpoints: ["post-action-screenshot"],
  };
}

async function createActiveCase(input: {
  cases: CaseRepository;
  caseId: string;
  platforms: readonly Platform[];
  title?: string;
}): Promise<CaseRevision> {
  const variants: CaseRevision["variants"] = {};
  const sources: CaseRevision["promotion"]["sources"] = {};
  for (const platform of input.platforms) {
    variants[platform] = { steps: [step(platform)] };
    sources[platform] = { sourceRunId: `run-source-${platform}` };
  }
  const revision = await input.cases.createDraft({
    schemaVersion: 2,
    caseId: input.caseId,
    title: input.title ?? input.caseId,
    promotion: { sources, validationIssues: [] },
    acceptanceCriteria: [
      {
        id: "expected-visible",
        description: "Expected state is visible",
        requiredEvidence: ["post-action-screenshot"],
      },
    ],
    variants,
  });
  await input.cases.activate(input.caseId, revision.revision, {
    confirmedBy: "user",
    confirmedAt: startedAt.toISOString(),
  });
  return revision;
}

describe("immutable run groups", () => {
  it("starts explicit multi-platform members and never rewrites group.json", async () => {
    const { projectRoot, cases } = await fixture();
    await createActiveCase({
      cases,
      caseId: "login",
      platforms: ["web", "ios-simulator"],
    });
    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["login"] },
      platforms: ["web", "ios-simulator"],
      execution: "local",
      readiness: readinessByPlatform(["web", "ios-simulator"]),
      now,
    });
    const groupPath = resolveRunGroupPaths(
      projectRoot,
      started.manifest.id,
    ).manifest;
    const originalManifestBytes = await readFile(groupPath, "utf8");

    expect(
      started.manifest.members.map(({ platform }) => platform).sort(),
    ).toEqual(["ios-simulator", "web"]);
    expect(started.manifest.exclusions).toEqual([]);
    expect(
      started.workOrders.every(
        (workOrder) => workOrder.runGroupId === started.manifest.id,
      ),
    ).toBe(true);

    await cancelRunGroup({
      projectRoot,
      runGroupId: started.manifest.id,
      reason: "fixture cleanup",
      now,
    });
    expect(await readFile(groupPath, "utf8")).toBe(originalManifestBytes);
  });

  it.each([
    ["one", ["web"]],
    ["two", ["web", "ios-simulator"]],
    ["three", allPlatforms],
  ] as const)("freezes %s selected platform set", async (_label, platforms) => {
    const { projectRoot, cases } = await fixture();
    await createActiveCase({ cases, caseId: "matrix", platforms });

    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["matrix"] },
      platforms: [...platforms],
      execution: "ci",
      readiness: readinessByPlatform(platforms),
      now,
    });

    expect(started.manifest.selectedPlatforms).toEqual(platforms);
    expect(started.manifest.members).toHaveLength(platforms.length);
    expect(
      new Set(started.manifest.members.map((member) => member.runId)).size,
    ).toBe(platforms.length);
  });

  it("selects every active case exactly once with --all-active semantics", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
    await createActiveCase({ cases, caseId: "logout", platforms: ["web"] });

    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "all-active" },
      platforms: ["web"],
      execution: "local",
      readiness: readinessByPlatform(["web"]),
      now,
    });

    expect(started.manifest.selectionMode).toBe("all-active");
    expect(
      started.manifest.members.map((member) => member.caseId).sort(),
    ).toEqual(["login", "logout"]);
  });

  it("uses each all-active index pointer snapshot without a second readActive", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
    const readActive = vi
      .spyOn(CaseRepository.prototype, "readActive")
      .mockRejectedValue(new Error("second active-pointer read"));

    await expect(
      startRunGroup({
        projectRoot,
        selection: { mode: "all-active" },
        platforms: ["web"],
        execution: "local",
        readiness: readinessByPlatform(["web"]),
        now,
      }),
    ).resolves.toMatchObject({
      manifest: { selectionMode: "all-active" },
    });
    expect(readActive).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured selected platform before persisting a group", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });

    await expect(
      startRunGroup({
        projectRoot,
        selection: { mode: "explicit", caseIds: ["login"] },
        platforms: ["ios-simulator"],
        execution: "local",
        readiness: readinessByPlatform(["ios-simulator"]),
        now,
      }),
    ).rejects.toMatchObject({ code: "platform.unconfigured" });
  });

  it("records missing platform variants as exclusions instead of child runs", async () => {
    const { projectRoot, cases } = await fixture(["web", "ios-simulator"]);
    const revision = await createActiveCase({
      cases,
      caseId: "web-only",
      platforms: ["web"],
    });

    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["web-only"] },
      platforms: ["web", "ios-simulator"],
      execution: "local",
      readiness: readinessByPlatform(["web", "ios-simulator"]),
      now,
    });

    expect(started.manifest.members).toHaveLength(1);
    expect(started.workOrders).toHaveLength(1);
    expect(started.manifest.exclusions).toEqual([
      {
        caseId: "web-only",
        revision: revision.revision,
        caseContentHash: revision.contentHash,
        platform: "ios-simulator",
        reason: "missing_variant",
      },
    ]);
  });

  it("keeps the selected active revision frozen after later activation", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    const first = await createActiveCase({
      cases,
      caseId: "login",
      platforms: ["web"],
      title: "First",
    });
    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["login"] },
      platforms: ["web"],
      execution: "local",
      readiness: readinessByPlatform(["web"]),
      now,
    });
    const second = await cases.createDraft({
      ...first,
      title: "Second",
    });
    await cases.activate("login", second.revision, {
      confirmedBy: "user",
      confirmedAt: startedAt.toISOString(),
    });

    const stored = await new RunGroupRepository(projectRoot, now).readManifest(
      started.manifest.id,
    );
    expect(stored.members[0]).toMatchObject({
      revision: first.revision,
      caseContentHash: first.contentHash,
    });
  });

  it("isolates member IDs and journals across parallel groups", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
    const input = {
      projectRoot,
      selection: { mode: "explicit" as const, caseIds: ["login"] },
      platforms: ["web" as const],
      execution: "local" as const,
      readiness: readinessByPlatform(["web"]),
      now,
    };

    const [first, second] = await Promise.all([
      startRunGroup(input),
      startRunGroup(input),
    ]);

    expect(first.manifest.id).not.toBe(second.manifest.id);
    expect(first.manifest.members[0]?.runId).not.toBe(
      second.manifest.members[0]?.runId,
    );
    expect(first.workOrders[0]?.runGroupId).toBe(first.manifest.id);
    expect(second.workOrders[0]?.runGroupId).toBe(second.manifest.id);
  });

  it("rejects finish until every frozen member is terminal", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["login"] },
      platforms: ["web"],
      execution: "local",
      readiness: readinessByPlatform(["web"]),
      now,
    });

    await expect(
      finishRunGroup({ projectRoot, runGroupId: started.manifest.id, now }),
    ).rejects.toMatchObject({ code: "run_group.members_not_terminal" });
  });

  it("finishes idempotently after all member identities and pins are terminal", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["login"] },
      platforms: ["web"],
      execution: "local",
      readiness: readinessByPlatform(["web"]),
      now,
    });
    const member = started.manifest.members[0]!;
    await cancelRun({
      projectRoot,
      runId: member.runId,
      reason: "terminal fixture",
      now,
    });

    const first = await finishRunGroup({
      projectRoot,
      runGroupId: started.manifest.id,
      now,
    });
    const second = await finishRunGroup({
      projectRoot,
      runGroupId: started.manifest.id,
      now,
    });

    expect(first).toEqual(second);
    expect(first.status).toBe("completed");
  });

  it("canonically cancels only non-terminal members and is idempotent", async () => {
    const { projectRoot, cases } = await fixture(["web", "ios-simulator"]);
    await createActiveCase({
      cases,
      caseId: "login",
      platforms: ["web", "ios-simulator"],
    });
    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["login"] },
      platforms: ["web", "ios-simulator"],
      execution: "local",
      readiness: readinessByPlatform(["web", "ios-simulator"]),
      now,
    });
    const terminalMember = started.manifest.members[0]!;
    await cancelRun({
      projectRoot,
      runId: terminalMember.runId,
      reason: "already terminal",
      now,
    });

    const first = await cancelRunGroup({
      projectRoot,
      runGroupId: started.manifest.id,
      reason: "stop matrix",
      now,
    });
    const second = await cancelRunGroup({
      projectRoot,
      runGroupId: started.manifest.id,
      reason: "stop matrix",
      now,
    });

    expect(first).toEqual(second);
    expect(first.status).toBe("cancelled");
    for (const member of started.manifest.members) {
      await expect(
        readRunState({ projectRoot, runId: member.runId, now }),
      ).resolves.toMatchObject({ status: "cancelled" });
    }
    const events = await new RunGroupRepository(projectRoot, now).readEvents(
      started.manifest.id,
    );
    expect(
      events.filter((event) => event.payload.phase === "cancelled"),
    ).toHaveLength(1);
  });

  it("resumes a prefix-failed materialization without replacing existing children", async () => {
    const { projectRoot, cases } = await fixture();
    await createActiveCase({
      cases,
      caseId: "matrix",
      platforms: allPlatforms,
    });
    const originalRepository = new RunRepository(projectRoot, now);
    const originalCreate = originalRepository.create.bind(originalRepository);
    let createCount = 0;
    const create = vi
      .spyOn(RunRepository.prototype, "create")
      .mockImplementation(async (workOrder: WorkOrder) => {
        createCount += 1;
        if (createCount === 2) throw new Error("injected child failure");
        return originalCreate(workOrder);
      });

    await expect(
      startRunGroup({
        projectRoot,
        selection: { mode: "explicit", caseIds: ["matrix"] },
        platforms: [...allPlatforms],
        execution: "local",
        readiness: readinessByPlatform(allPlatforms),
        now,
      }),
    ).rejects.toMatchObject({
      code: "run_group.materialization_failed",
      details: {
        causeCode: "internal.unexpected_error",
      },
    });
    create.mockRestore();

    const [runGroupId] = await readdir(
      join(projectRoot, ".ai-qa", "run-groups"),
    );
    expect(runGroupId).toMatch(/^run-group-/u);
    const repository = new RunGroupRepository(projectRoot, now);
    const manifest = await repository.readManifest(runGroupId!);
    expect(await readdir(join(projectRoot, ".ai-qa", "runs"))).toHaveLength(1);
    await expect(
      finishRunGroup({ projectRoot, runGroupId: runGroupId!, now }),
    ).rejects.toMatchObject({ code: "run_group.not_materialized" });

    const first = await materializeRunGroup({
      projectRoot,
      runGroupId: runGroupId!,
      now,
    });
    const second = await materializeRunGroup({
      projectRoot,
      runGroupId: runGroupId!,
      now,
    });

    expect(first).toEqual(second);
    expect(first.status).toBe("materialized");
    for (const member of manifest.members) {
      await expect(
        new RunRepository(projectRoot, now).readVerifiedWorkOrder(member.runId),
      ).resolves.toEqual(member.workOrder);
    }
    const events = await repository.readEvents(runGroupId!);
    expect(
      events.filter((event) => event.payload.phase === "materialized"),
    ).toHaveLength(1);
  });

  it("materializes missing children before cancelling a prefix-failed group", async () => {
    const { projectRoot, cases } = await fixture(["web", "ios-simulator"]);
    await createActiveCase({
      cases,
      caseId: "matrix",
      platforms: ["web", "ios-simulator"],
    });
    const originalRepository = new RunRepository(projectRoot, now);
    const originalCreate = originalRepository.create.bind(originalRepository);
    let createCount = 0;
    const create = vi
      .spyOn(RunRepository.prototype, "create")
      .mockImplementation(async (workOrder: WorkOrder) => {
        createCount += 1;
        if (createCount === 2) throw new Error("injected child failure");
        return originalCreate(workOrder);
      });
    await expect(
      startRunGroup({
        projectRoot,
        selection: { mode: "explicit", caseIds: ["matrix"] },
        platforms: ["web", "ios-simulator"],
        execution: "local",
        readiness: readinessByPlatform(["web", "ios-simulator"]),
        now,
      }),
    ).rejects.toMatchObject({
      code: "run_group.materialization_failed",
    });
    create.mockRestore();
    const [runGroupId] = await readdir(
      join(projectRoot, ".ai-qa", "run-groups"),
    );
    expect(runGroupId).toMatch(/^run-group-/u);

    await expect(
      cancelRunGroup({
        projectRoot,
        runGroupId: runGroupId!,
        reason: "cancel partial group",
        now,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
    const manifest = await new RunGroupRepository(
      projectRoot,
      now,
    ).readManifest(runGroupId!);
    for (const member of manifest.members) {
      await expect(
        readRunState({ projectRoot, runId: member.runId, now }),
      ).resolves.toMatchObject({ status: "cancelled" });
    }
    expect(
      (
        await new RunGroupRepository(projectRoot, now).readEvents(runGroupId!)
      ).map((event) => event.payload.phase),
    ).toEqual(["started", "materialized", "cancelled"]);
  });

  it.each([
    "directory-only",
    "work-order-only",
    "missing-start-journal",
  ] as const)(
    "ignores unrelated %s staging residue while resuming a frozen child",
    async (residueKind) => {
      const { projectRoot, cases } = await fixture(["web"]);
      await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
      const create = vi
        .spyOn(RunRepository.prototype, "create")
        .mockRejectedValueOnce(new Error("injected pre-publication failure"));
      await expect(
        startRunGroup({
          projectRoot,
          selection: { mode: "explicit", caseIds: ["login"] },
          platforms: ["web"],
          execution: "local",
          readiness: readinessByPlatform(["web"]),
          now,
        }),
      ).rejects.toMatchObject({ code: "run_group.materialization_failed" });
      create.mockRestore();

      const [runGroupId] = await readdir(
        join(projectRoot, ".ai-qa", "run-groups"),
      );
      const repository = new RunGroupRepository(projectRoot, now);
      const manifest = await repository.readManifest(runGroupId!);
      const member = manifest.members[0]!;
      const residue = join(
        projectRoot,
        ".ai-qa",
        "runs",
        `.run-staging-${member.runId}-seeded-${residueKind}`,
      );
      await mkdir(residue);
      if (residueKind !== "directory-only") {
        await writeFile(
          join(residue, "work-order.json"),
          JSON.stringify(member.workOrder),
          "utf8",
        );
      }
      if (residueKind === "missing-start-journal") {
        await writeFile(join(residue, "events.jsonl"), "{}\n", "utf8");
      }

      await expect(
        materializeRunGroup({ projectRoot, runGroupId: runGroupId!, now }),
      ).resolves.toMatchObject({ status: "materialized" });
      await expect(
        new RunRepository(projectRoot, now).readVerifiedWorkOrder(member.runId),
      ).resolves.toEqual(member.workOrder);
      expect((await readdir(residue)).sort()).toEqual(
        residueKind === "directory-only"
          ? []
          : residueKind === "work-order-only"
            ? ["work-order.json"]
            : ["events.jsonl", "work-order.json"],
      );
      expect(
        (await repository.readEvents(runGroupId!)).map(
          (event) => event.payload.phase,
        ),
      ).toEqual(["started", "materialized"]);
    },
  );

  it("preserves a malformed final child directory instead of replacing it", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
    const create = vi
      .spyOn(RunRepository.prototype, "create")
      .mockRejectedValueOnce(new Error("injected pre-publication failure"));
    await expect(
      startRunGroup({
        projectRoot,
        selection: { mode: "explicit", caseIds: ["login"] },
        platforms: ["web"],
        execution: "local",
        readiness: readinessByPlatform(["web"]),
        now,
      }),
    ).rejects.toMatchObject({ code: "run_group.materialization_failed" });
    create.mockRestore();
    const [runGroupId] = await readdir(
      join(projectRoot, ".ai-qa", "run-groups"),
    );
    const manifest = await new RunGroupRepository(
      projectRoot,
      now,
    ).readManifest(runGroupId!);
    const finalDirectory = join(
      projectRoot,
      ".ai-qa",
      "runs",
      manifest.members[0]!.runId,
    );
    await mkdir(finalDirectory);
    await writeFile(join(finalDirectory, "do-not-delete"), "preserve", "utf8");

    await expect(
      materializeRunGroup({ projectRoot, runGroupId: runGroupId!, now }),
    ).rejects.toMatchObject({ code: "run_group.member_integrity_error" });
    expect(await readdir(finalDirectory)).toEqual(["do-not-delete"]);
    expect(await readFile(join(finalDirectory, "do-not-delete"), "utf8")).toBe(
      "preserve",
    );
  });

  it.each(["revision", "caseContentHash"] as const)(
    "rejects a manifest with mixed case %s identity",
    async (field) => {
      const { projectRoot, cases } = await fixture(["web", "ios-simulator"]);
      await createActiveCase({
        cases,
        caseId: "login",
        platforms: ["web", "ios-simulator"],
      });
      const started = await startRunGroup({
        projectRoot,
        selection: { mode: "explicit", caseIds: ["login"] },
        platforms: ["web", "ios-simulator"],
        execution: "local",
        readiness: readinessByPlatform(["web", "ios-simulator"]),
        now,
      });
      const candidate = structuredClone(started.manifest);
      const member = candidate.members[1]!;
      if (field === "revision") {
        member.revision += 1;
        member.workOrder.pinnedCase!.revision += 1;
      } else {
        member.caseContentHash = "sha256:mixed";
        member.workOrder.pinnedCase!.caseContentHash = "sha256:mixed";
      }

      expect(runGroupManifestSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it("rejects a manifest that omits a selected case/platform cell", async () => {
    const { projectRoot, cases } = await fixture(["web", "ios-simulator"]);
    await createActiveCase({
      cases,
      caseId: "login",
      platforms: ["web", "ios-simulator"],
    });
    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["login"] },
      platforms: ["web", "ios-simulator"],
      execution: "local",
      readiness: readinessByPlatform(["web", "ios-simulator"]),
      now,
    });
    const candidate = structuredClone(started.manifest);
    candidate.members.pop();
    candidate.maximumBudget = candidate.members.reduce(
      (total, member) => ({
        maxToolCalls: total.maxToolCalls + member.budget.maxToolCalls,
        maxRecoveryActions:
          total.maxRecoveryActions + member.budget.maxRecoveryActions,
      }),
      { maxToolCalls: 0, maxRecoveryActions: 0 },
    );

    expect(runGroupManifestSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a corrupted manifest hash anchor", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["login"] },
      platforms: ["web"],
      execution: "local",
      readiness: readinessByPlatform(["web"]),
      now,
    });
    const paths = resolveRunGroupPaths(projectRoot, started.manifest.id);
    const events = (await new RunGroupRepository(projectRoot, now).readEvents(
      started.manifest.id,
    )) as unknown as Array<Record<string, unknown>>;
    const payload = events[0]!.payload as Record<string, unknown>;
    payload.manifestHash = `sha256:${"0".repeat(64)}`;
    await writeFile(
      paths.events,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    await expect(
      new RunGroupRepository(projectRoot, now).readManifest(
        started.manifest.id,
      ),
    ).rejects.toMatchObject({ code: "run_group.integrity_error" });
  });

  it("never replaces a child whose immutable case pin mismatches the manifest", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["login"] },
      platforms: ["web"],
      execution: "local",
      readiness: readinessByPlatform(["web"]),
      now,
    });
    const member = started.manifest.members[0]!;
    await rm(join(projectRoot, ".ai-qa", "runs", member.runId), {
      recursive: true,
    });
    const mismatched = workOrderSchema.parse({
      ...member.workOrder,
      pinnedCase: {
        ...member.workOrder.pinnedCase!,
        revision: member.revision + 1,
      },
    });
    await new RunRepository(projectRoot, now).create(mismatched);

    await expect(
      materializeRunGroup({
        projectRoot,
        runGroupId: started.manifest.id,
        now,
      }),
    ).rejects.toMatchObject({ code: "run_group.member_integrity_error" });
    await expect(
      new RunRepository(projectRoot, now).readVerifiedWorkOrder(member.runId),
    ).resolves.toEqual(mismatched);
  });

  it("rejects symlinked group roots and group files without touching outside state", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-group-outside-"));
    const groupsRoot = join(projectRoot, ".ai-qa", "run-groups");
    await rm(groupsRoot, { recursive: true });
    await symlink(outside, groupsRoot);

    await expect(
      startRunGroup({
        projectRoot,
        selection: { mode: "explicit", caseIds: ["login"] },
        platforms: ["web"],
        execution: "local",
        readiness: readinessByPlatform(["web"]),
        now,
      }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
    expect(await readdir(outside)).toEqual([]);

    await rm(groupsRoot);
    await mkdir(groupsRoot);
    const started = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["login"] },
      platforms: ["web"],
      execution: "local",
      readiness: readinessByPlatform(["web"]),
      now,
    });
    const manifestPath = resolveRunGroupPaths(
      projectRoot,
      started.manifest.id,
    ).manifest;
    const outsideManifest = join(outside, "group.json");
    await writeFile(outsideManifest, await readFile(manifestPath, "utf8"));
    await rm(manifestPath);
    await symlink(outsideManifest, manifestPath);
    await expect(
      new RunGroupRepository(projectRoot, now).readManifest(
        started.manifest.id,
      ),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
  });

  it("exposes start, resume, cancel, and finish through the public CLI", async () => {
    const { projectRoot, cases } = await fixture(["web"]);
    await createActiveCase({ cases, caseId: "login", platforms: ["web"] });
    const readyInput = JSON.stringify({ web: readiness("web") });
    const startCli = createCapturedCli({
      cwd: projectRoot,
      now,
      readStdin: () => Promise.resolve(readyInput),
    });
    expect(
      await runCli(
        [
          "run-group",
          "start",
          "--case",
          "login",
          "--platform",
          "web",
          "--execution",
          "local",
          "--stdin-json",
        ],
        startCli.context,
      ),
    ).toBe(0);
    const started = JSON.parse(startCli.stdout.join("")) as {
      manifest: { id: string; members: Array<{ runId: string }> };
    };

    const resumeCli = createCapturedCli({ cwd: projectRoot, now });
    expect(
      await runCli(
        ["run-group", "resume", started.manifest.id],
        resumeCli.context,
      ),
    ).toBe(0);
    expect(JSON.parse(resumeCli.stdout.join(""))).toMatchObject({
      status: "materialized",
    });

    const cancelCli = createCapturedCli({ cwd: projectRoot, now });
    expect(
      await runCli(
        ["run-group", "cancel", started.manifest.id, "--reason", "stop matrix"],
        cancelCli.context,
      ),
    ).toBe(0);
    expect(JSON.parse(cancelCli.stdout.join(""))).toMatchObject({
      status: "cancelled",
    });

    const finishStarted = await startRunGroup({
      projectRoot,
      selection: { mode: "explicit", caseIds: ["login"] },
      platforms: ["web"],
      execution: "local",
      readiness: readinessByPlatform(["web"]),
      now,
    });
    await cancelRun({
      projectRoot,
      runId: finishStarted.manifest.members[0]!.runId,
      reason: "terminal fixture",
      now,
    });
    const finishCli = createCapturedCli({ cwd: projectRoot, now });
    expect(
      await runCli(
        ["run-group", "finish", finishStarted.manifest.id],
        finishCli.context,
      ),
    ).toBe(0);
    expect(JSON.parse(finishCli.stdout.join(""))).toMatchObject({
      status: "completed",
    });
  });
});
