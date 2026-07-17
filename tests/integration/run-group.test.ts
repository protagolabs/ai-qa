import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseRepository } from "../../src/core/cases/repository.js";
import type { CaseRevision } from "../../src/core/cases/schema.js";
import { resolveRunGroupPaths } from "../../src/core/run-groups/paths.js";
import { RunGroupRepository } from "../../src/core/run-groups/repository.js";
import type { Platform } from "../../src/core/platforms/schema.js";
import type { PlatformReadiness } from "../../src/core/readiness/schema.js";
import { cancelRunGroup } from "../../src/services/run-groups/cancel-run-group.js";
import { finishRunGroup } from "../../src/services/run-groups/finish-run-group.js";
import { startRunGroup } from "../../src/services/run-groups/start-run-group.js";
import { readRunState } from "../../src/services/run-protocol/read-run-state.js";
import { cancelRun } from "../../src/services/run-protocol/run-lifecycle.js";
import {
  initializeTestProject,
  projectConfig,
} from "../helpers/project-fixture.js";

const startedAt = new Date("2026-07-17T00:00:00.000Z");
const now = () => startedAt;
const allPlatforms = [
  "web",
  "ios-simulator",
  "android-emulator",
] as const;

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
    schemaVersion: 1,
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
  ] as const)(
    "freezes %s selected platform set",
    async (_label, platforms) => {
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
    },
  );

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
});
