import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import type { EvidenceRecord } from "../../src/core/evidence/schema.js";
import { RunRepository } from "../../src/core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
} from "../../src/core/runs/schema.js";
import { draftCaseFromRun } from "../../src/services/case-promotion/draft-case.js";
import { generateRunReport } from "../../src/services/report-generation/generate-run-report.js";
import { repairRun } from "../../src/services/run-repair/repair-run.js";
import { finalizeRun } from "../../src/services/run-protocol/finalize-run.js";
import { registerEvidence } from "../../src/services/run-protocol/register-evidence.js";
import { resumeRun } from "../../src/services/run-protocol/run-lifecycle.js";
import { RunProtocolService } from "../../src/services/run-protocol/run-protocol-service.js";
import { VerdictService } from "../../src/services/run-protocol/verdict-service.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import { initializeTestProject } from "../helpers/project-fixture.js";

const runId = "run-1";
const fixedNow = () => new Date("2026-07-23T08:00:00.000Z");
const tornBytes = Buffer.from('{"schemaVersion":1,"id":"event-torn"');

interface RepairFixture {
  projectRoot: string;
  repository: RunRepository;
  captureActionId: string;
  sourcePath: string;
  orphan?: EvidenceRecord;
  cleanJournal: Buffer;
}

interface StoredRepairRelocation {
  kind: "evidence-file" | "evidence-index-entry" | "journal-tail";
  evidenceId?: string;
  sourcePath: string;
  recoveryPath: string;
  contentHash: string;
}

interface StoredRepairManifest {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  completedAt?: string;
  relocations: StoredRepairRelocation[];
  journalTail?: {
    truncateOffset: number;
    byteLength: number;
    contentHash: string;
  };
  orphanedEvidenceIds: string[];
}

describe("run repair", () => {
  it("repairs an orphaned evidence entry and reports it", async () => {
    const fixture = await createRepairFixture({ orphan: true });
    const orphan = requiredOrphan(fixture);
    const indexPath = evidenceIndexPath(fixture.projectRoot);

    const report = await repairRun({
      projectRoot: fixture.projectRoot,
      runId,
      now: fixedNow,
    });

    expect(report.runId).toBe(runId);
    expect(report.relocated).toHaveLength(2);
    expect(report.relocated).toEqual([
      expect.objectContaining({
        kind: "evidence-file",
        reference: orphan.id,
      }),
      expect.objectContaining({
        kind: "evidence-index-entry",
        reference: orphan.id,
      }),
    ]);
    expect(await readFile(indexPath, "utf8")).toBe("");
    await expect(
      lstat(
        resolveProjectPath(fixture.projectRoot, orphan.projectRelativePath),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const recoveredFile = report.relocated.find(
      (entry) => entry.kind === "evidence-file",
    );
    const recoveredIndexEntry = report.relocated.find(
      (entry) => entry.kind === "evidence-index-entry",
    );
    expect(
      await readFile(
        resolveProjectPath(fixture.projectRoot, recoveredFile!.recoveryPath),
      ),
    ).toEqual(Buffer.from("orphaned-image"));
    expect(
      JSON.parse(
        (
          await readFile(
            resolveProjectPath(
              fixture.projectRoot,
              recoveredIndexEntry!.recoveryPath,
            ),
            "utf8",
          )
        ).trim(),
      ),
    ).toEqual(orphan);

    await expect(
      resumeRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).resolves.toMatchObject({ runId, status: "running" });
    await new VerdictService(fixture.projectRoot, runId, fixedNow).set({
      classification: "not_verified",
      reasonCode: "incomplete_coverage",
      summary: "The repaired orphan was excluded from the run",
      criterionResults: [],
    });
    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).resolves.toMatchObject({ runId, status: "completed" });
  });

  it("repairs a torn journal tail", async () => {
    const fixture = await createRepairFixture({ torn: true });
    const offset = fixture.cleanJournal.byteLength;

    const report = await repairRun({
      projectRoot: fixture.projectRoot,
      runId,
      now: fixedNow,
    });

    expect(await fixture.repository.journal(runId).readAll()).not.toHaveLength(
      0,
    );
    expect(await readFile(journalPath(fixture.projectRoot))).toEqual(
      fixture.cleanJournal,
    );
    expect(report.relocated).toEqual([
      expect.objectContaining({
        kind: "journal-tail",
        reference: `events.jsonl@${offset}`,
      }),
    ]);
    expect(
      await readFile(
        resolveProjectPath(
          fixture.projectRoot,
          report.relocated[0]!.recoveryPath,
        ),
      ),
    ).toEqual(tornBytes);
  });

  it("is idempotent on a clean run", async () => {
    const fixture = await createRepairFixture();

    await expect(
      repairRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).resolves.toEqual({ runId, relocated: [] });
    await expect(
      repairRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).resolves.toEqual({ runId, relocated: [] });

    const captured = createCapturedCli({
      cwd: fixture.projectRoot,
      now: fixedNow,
    });
    await expect(
      runCli(
        ["--project", fixture.projectRoot, "run", "repair", runId],
        captured.context,
      ),
    ).resolves.toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(JSON.parse(captured.stdout.join(""))).toEqual({
      runId,
      relocated: [],
    });
  });

  it("resumes deterministically from every crash boundary", async () => {
    const seed = await createRepairFixture({ orphan: true, torn: true });
    const uninterruptedRoot = await cloneProject(seed.projectRoot);
    const uninterruptedReport = await repairRun({
      projectRoot: uninterruptedRoot,
      runId,
      now: fixedNow,
    });
    const expectedTree = await snapshotTree(join(uninterruptedRoot, ".ai-qa"));
    const completedManifest = await readManifest(uninterruptedRoot);
    expect(completedManifest.completedAt).toBe(fixedNow().toISOString());

    for (const boundary of [1, 2, 3, 4, 5] as const) {
      const projectRoot = await cloneProject(seed.projectRoot);
      const incompleteManifest = structuredClone(completedManifest);
      delete incompleteManifest.completedAt;
      await writeManifest(projectRoot, incompleteManifest);
      if (boundary >= 2) {
        await applyRecoveryCopies(projectRoot, incompleteManifest);
      }
      if (boundary >= 3) {
        await applyIndexRewrite(projectRoot, incompleteManifest);
      }
      if (boundary >= 4) {
        await applyJournalTruncate(projectRoot, incompleteManifest);
      }
      if (boundary >= 5) {
        await applySourceDeletes(projectRoot, incompleteManifest);
      }

      await expect(
        repairRun({ projectRoot, runId, now: fixedNow }),
      ).resolves.toEqual(uninterruptedReport);
      expect(await snapshotTree(join(projectRoot, ".ai-qa"))).toEqual(
        expectedTree,
      );
    }
  });

  it("blocks every run consumer while a repair is incomplete", async () => {
    const fixture = await createRepairFixture();
    await writeManifest(fixture.projectRoot, emptyIncompleteManifest());
    const sourcePath = join(fixture.projectRoot, "blocked-evidence.png");
    await writeFile(sourcePath, "blocked evidence");
    const protocol = new RunProtocolService(
      fixture.projectRoot,
      runId,
      fixedNow,
    );
    const verdicts = new VerdictService(fixture.projectRoot, runId, fixedNow);
    const expectedError = {
      code: "run.repair_incomplete",
      message: `An interrupted repair exists; run "ai-qa run repair <run-id>"`,
      details: { runId },
    };

    await appendFile(journalPath(fixture.projectRoot), tornBytes);
    await expect(
      protocol.planAction({
        idempotencyKey: "blocked-action",
        kind: "observation",
        intent: "Observe while repair is incomplete",
        tool: "chrome-devtools-mcp",
        target: { description: "Page" },
      }),
    ).rejects.toMatchObject(expectedError);
    await writeFile(journalPath(fixture.projectRoot), fixture.cleanJournal);
    const before = await snapshotTree(join(fixture.projectRoot, ".ai-qa"));

    await expect(
      registerEvidence({
        projectRoot: fixture.projectRoot,
        runId,
        payload: {
          sourcePath,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId: fixture.captureActionId,
          idempotencyKey: "blocked-evidence",
        },
        criterionIds: ["authenticated-home-visible"],
        observationIds: [],
        now: fixedNow,
      }),
    ).rejects.toMatchObject(expectedError);
    await expect(
      verdicts.set({
        classification: "not_verified",
        reasonCode: "incomplete_coverage",
        summary: "Blocked by repair",
        criterionResults: [],
      }),
    ).rejects.toMatchObject(expectedError);
    await expect(
      resumeRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject(expectedError);
    await expect(
      finalizeRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject(expectedError);
    await expect(
      generateRunReport({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject(expectedError);
    await expect(
      draftCaseFromRun({
        projectRoot: fixture.projectRoot,
        runId,
        input: {
          caseId: "case-repair-gate",
          title: "Repair gate",
          steps: [
            {
              sourceActionId: fixture.captureActionId,
              intent: "Capture the home",
              target: {
                description: "Home",
                stability: "stable",
                stabilityRationale: "The page landmark is stable",
              },
              expectedState: "Home is visible",
              assertionStrategy: "Inspect the visible page",
              evidenceCheckpoints: ["post-action-screenshot"],
            },
          ],
          excludedActions: [],
        },
      }),
    ).rejects.toMatchObject(expectedError);
    expect(await snapshotTree(join(fixture.projectRoot, ".ai-qa"))).toEqual(
      before,
    );

    await expect(
      repairRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).resolves.toEqual({ runId, relocated: [] });
  });

  it.each(Array.from({ length: 20 }, (_, iteration) => iteration))(
    "does not deadlock against concurrent evidence registration (iteration %i)",
    { timeout: 15_000 },
    async (iteration) => {
      const fixture = await createRepairFixture({ orphan: true });
      const sourcePath = join(
        fixture.projectRoot,
        `concurrent-${iteration}.png`,
      );
      await writeFile(sourcePath, `concurrent-${iteration}`);

      const [repair, evidence] = await Promise.allSettled([
        repairRun({
          projectRoot: fixture.projectRoot,
          runId,
          now: fixedNow,
        }),
        registerEvidence({
          projectRoot: fixture.projectRoot,
          runId,
          payload: {
            sourcePath,
            mediaType: "image/png",
            sourceTool: "chrome-devtools-mcp",
            sensitivity: "internal",
            evidenceKinds: ["post-action-screenshot"],
            captureActionId: fixture.captureActionId,
            idempotencyKey: `concurrent-${iteration}`,
          },
          criterionIds: ["authenticated-home-visible"],
          observationIds: [],
          now: fixedNow,
        }),
      ]);

      expect(repair).toMatchObject({
        status: "fulfilled",
        value: {
          relocated: [
            expect.objectContaining({ kind: "evidence-file" }),
            expect.objectContaining({ kind: "evidence-index-entry" }),
          ],
        },
      });
      if (evidence.status === "fulfilled") {
        expect(evidence.value.id).toMatch(/^evidence-/u);
      } else {
        expect(evidence.reason).toMatchObject({
          code: "evidence.orphaned_entries",
        });
      }
    },
  );

  it(
    "serializes repair and evidence registration through both locks",
    { timeout: 15_000 },
    async () => {
      const fixture = await createRepairFixture({ orphan: true });
      const indexPath = evidenceIndexPath(fixture.projectRoot);
      const sourcePath = join(fixture.projectRoot, "barrier-evidence.png");
      await writeFile(sourcePath, "barrier evidence");
      const releaseEvidence = await lockfile.lock(indexPath, {
        realpath: false,
      });
      let repairSettled = false;
      let evidenceSettled = false;
      const repair = repairRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }).finally(() => {
        repairSettled = true;
      });
      await waitForPath(`${journalPath(fixture.projectRoot)}.lock`);
      const evidence = registerEvidence({
        projectRoot: fixture.projectRoot,
        runId,
        payload: {
          sourcePath,
          mediaType: "image/png",
          sourceTool: "chrome-devtools-mcp",
          sensitivity: "internal",
          evidenceKinds: ["post-action-screenshot"],
          captureActionId: fixture.captureActionId,
          idempotencyKey: "barrier-evidence",
        },
        criterionIds: ["authenticated-home-visible"],
        observationIds: [],
        now: fixedNow,
      }).finally(() => {
        evidenceSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(repairSettled).toBe(false);
      expect(evidenceSettled).toBe(false);
      await releaseEvidence();
      await expect(repair).resolves.toMatchObject({
        runId,
        relocated: [
          { kind: "evidence-file" },
          { kind: "evidence-index-entry" },
        ],
      });
      await expect(evidence).resolves.toMatchObject({
        idempotencyKey: "barrier-evidence",
      });
    },
  );

  it(
    "gates a consumer after racing repair publishes an incomplete manifest",
    { timeout: 15_000 },
    async () => {
      const fixture = await createRepairFixture({ orphan: true, torn: true });
      await mkdir(recoveryDirectory(fixture.projectRoot), { recursive: true });
      await writeFile(
        join(recoveryDirectory(fixture.projectRoot), "evidence"),
        "blocks recovery descendants",
      );
      const releaseEvidence = await lockfile.lock(
        evidenceIndexPath(fixture.projectRoot),
        { realpath: false },
      );
      let repairSettled = false;
      let consumerSettled = false;
      const repair = repairRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          repairSettled = true;
        });
      await waitForPath(`${journalPath(fixture.projectRoot)}.lock`);
      const consumer = new RunProtocolService(
        fixture.projectRoot,
        runId,
        fixedNow,
      )
        .planAction({
          idempotencyKey: "racing-consumer",
          kind: "observation",
          intent: "Must wait for repair publication",
          tool: "chrome-devtools-mcp",
          target: { description: "Page" },
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          consumerSettled = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(repairSettled).toBe(false);
      expect(consumerSettled).toBe(false);

      await releaseEvidence();
      await expect(repair).resolves.toMatchObject({
        error: { code: "storage.integrity_error" },
      });
      await expect(consumer).resolves.toMatchObject({
        error: { code: "run.repair_incomplete" },
      });
      const manifest = await readManifest(fixture.projectRoot);
      expect(manifest.completedAt).toBeUndefined();
      expect(await readFile(journalPath(fixture.projectRoot))).toEqual(
        Buffer.concat([fixture.cleanJournal, tornBytes]),
      );
    },
  );

  it("refuses a malicious or corrupted manifest before any I/O", async () => {
    const escaping = await createRepairFixture({ orphan: true });
    const escapingManifest = await orphanManifest(escaping);
    escapingManifest.relocations[0]!.sourcePath = "../../outside.txt";
    await writeManifest(escaping.projectRoot, escapingManifest);
    const escapingBefore = await snapshotTree(
      join(escaping.projectRoot, ".ai-qa"),
    );

    await expect(
      repairRun({
        projectRoot: escaping.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(await snapshotTree(join(escaping.projectRoot, ".ai-qa"))).toEqual(
      escapingBefore,
    );

    const wrongRoot = await createRepairFixture({ orphan: true });
    const wrongRootManifest = await orphanManifest(wrongRoot);
    wrongRootManifest.relocations[0]!.recoveryPath = `.ai-qa/evidence/${runId}/files/recovered.png`;
    await writeManifest(wrongRoot.projectRoot, wrongRootManifest);
    const wrongRootBefore = await snapshotTree(
      join(wrongRoot.projectRoot, ".ai-qa"),
    );

    await expect(
      repairRun({
        projectRoot: wrongRoot.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(await snapshotTree(join(wrongRoot.projectRoot, ".ai-qa"))).toEqual(
      wrongRootBefore,
    );

    const corruptedHash = await createRepairFixture({ orphan: true });
    const corruptedHashManifest = await orphanManifest(corruptedHash);
    corruptedHashManifest.relocations[1]!.contentHash = `sha256:${"0".repeat(64)}`;
    await writeManifest(corruptedHash.projectRoot, corruptedHashManifest);
    const corruptedHashBefore = await snapshotTree(
      join(corruptedHash.projectRoot, ".ai-qa"),
    );

    await expect(
      repairRun({
        projectRoot: corruptedHash.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "run.repair_integrity_error" });
    expect(
      await snapshotTree(join(corruptedHash.projectRoot, ".ai-qa")),
    ).toEqual(corruptedHashBefore);

    const symlinked = await createRepairFixture({ orphan: true });
    const symlinkedManifest = await orphanManifest(symlinked);
    const outsideRecovery = await mkdtemp(
      join(tmpdir(), "ai-qa-repair-outside-"),
    );
    await writeFile(
      join(outsideRecovery, "repair-manifest.json"),
      serializeManifest(symlinkedManifest),
      "utf8",
    );
    await mkdir(join(symlinked.projectRoot, ".ai-qa", "recovery"), {
      recursive: true,
    });
    await symlink(
      outsideRecovery,
      recoveryDirectory(symlinked.projectRoot),
      "dir",
    );
    const symlinkedBefore = await snapshotTree(
      join(symlinked.projectRoot, ".ai-qa"),
    );
    const outsideBefore = await snapshotTree(outsideRecovery);

    await expect(
      repairRun({
        projectRoot: symlinked.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
    expect(await snapshotTree(join(symlinked.projectRoot, ".ai-qa"))).toEqual(
      symlinkedBefore,
    );
    expect(await snapshotTree(outsideRecovery)).toEqual(outsideBefore);
  });

  it("rejects ancestor and descendant recovery paths before any I/O", async () => {
    const fixture = await createRepairFixture({ orphan: true });
    const manifest = await orphanManifest(fixture);
    const ancestor = `.ai-qa/recovery/${runId}/evidence/collision`;
    manifest.relocations[0]!.recoveryPath = ancestor;
    manifest.relocations[1]!.recoveryPath = `${ancestor}/index.jsonl`;
    await writeManifest(fixture.projectRoot, manifest);
    const before = await snapshotTree(join(fixture.projectRoot, ".ai-qa"));

    await expect(
      repairRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(await snapshotTree(join(fixture.projectRoot, ".ai-qa"))).toEqual(
      before,
    );
  });

  it("rejects relocation paths inside the deletion-claim namespace", async () => {
    const fixture = await createRepairFixture({ orphan: true });
    const orphan = requiredOrphan(fixture);
    const manifest = await orphanManifest(fixture);
    manifest.relocations[0]!.recoveryPath = `.ai-qa/recovery/${runId}/deletion-claims/${orphan.id}/entry`;
    await writeManifest(fixture.projectRoot, manifest);
    const before = await snapshotTree(join(fixture.projectRoot, ".ai-qa"));

    await expect(
      repairRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(await snapshotTree(join(fixture.projectRoot, ".ai-qa"))).toEqual(
      before,
    );
  });

  it("rejects a forged torn-tail plan for a healthy journal", async () => {
    const healthyJournal = await createRepairFixture();
    await registerLiveEvidence(healthyJournal, "healthy-journal-evidence");
    const healthyBytes = await readFile(
      journalPath(healthyJournal.projectRoot),
    );
    const forgedTail: StoredRepairManifest = {
      schemaVersion: 1,
      runId,
      createdAt: fixedNow().toISOString(),
      relocations: [
        {
          kind: "journal-tail",
          sourcePath: `.ai-qa/runs/${runId}/events.jsonl`,
          recoveryPath: `.ai-qa/recovery/${runId}/journal/forged.tail`,
          contentHash: sha256(healthyBytes),
        },
      ],
      journalTail: {
        truncateOffset: 0,
        byteLength: healthyBytes.byteLength,
        contentHash: sha256(healthyBytes),
      },
      orphanedEvidenceIds: [],
    };
    await writeManifest(healthyJournal.projectRoot, forgedTail);
    const healthyBefore = await snapshotTree(
      join(healthyJournal.projectRoot, ".ai-qa"),
    );

    await expect(
      repairRun({
        projectRoot: healthyJournal.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "run.repair_integrity_error" });
    expect(
      await snapshotTree(join(healthyJournal.projectRoot, ".ai-qa")),
    ).toEqual(healthyBefore);
  });

  it("rejects a forged orphan plan for live journaled evidence", async () => {
    const liveEvidence = await createRepairFixture();
    const liveRecord = await registerLiveEvidence(
      liveEvidence,
      "journaled-evidence",
    );
    await writeManifest(
      liveEvidence.projectRoot,
      await evidenceManifest(liveEvidence, liveRecord),
    );
    const evidenceBefore = await snapshotTree(
      join(liveEvidence.projectRoot, ".ai-qa"),
    );

    await expect(
      repairRun({
        projectRoot: liveEvidence.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "run.repair_integrity_error" });
    expect(
      await snapshotTree(join(liveEvidence.projectRoot, ".ai-qa")),
    ).toEqual(evidenceBefore);
  });

  it("rejects a journal-only retained evidence record before planning an orphan repair", async () => {
    const fixture = await createRepairFixture();
    const live = await registerLiveEvidence(fixture, "journal-only-live");
    const orphan = await addOrphanIndexRecord(fixture, live, "journal-only");
    await writeFile(
      evidenceIndexPath(fixture.projectRoot),
      `${JSON.stringify(orphan)}\n`,
    );
    const before = await snapshotTree(join(fixture.projectRoot, ".ai-qa"));

    await expect(
      repairRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
    expect(await snapshotTree(join(fixture.projectRoot, ".ai-qa"))).toEqual(
      before,
    );
  });

  it("rejects retained journal/index content drift before planning an orphan repair", async () => {
    const fixture = await createRepairFixture();
    const live = await registerLiveEvidence(fixture, "mismatched-live");
    const orphan = await addOrphanIndexRecord(fixture, live, "mismatch");
    const mismatched: EvidenceRecord = {
      ...live,
      sensitivity: "sensitive",
    };
    await writeFile(
      evidenceIndexPath(fixture.projectRoot),
      `${JSON.stringify(mismatched)}\n${JSON.stringify(orphan)}\n`,
    );
    const before = await snapshotTree(join(fixture.projectRoot, ".ai-qa"));

    await expect(
      repairRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "evidence.integrity_error" });
    expect(await snapshotTree(join(fixture.projectRoot, ".ai-qa"))).toEqual(
      before,
    );
  });

  it("preflights changed deletion sources after recovery copies exist", async () => {
    const fixture = await createRepairFixture({ orphan: true });
    const manifest = await orphanManifest(fixture);
    await writeManifest(fixture.projectRoot, manifest);
    await applyRecoveryCopies(fixture.projectRoot, manifest);
    await writeFile(
      resolveProjectPath(
        fixture.projectRoot,
        manifest.relocations[0]!.sourcePath,
      ),
      "replacement-after-copy",
    );
    const before = await snapshotTree(join(fixture.projectRoot, ".ai-qa"));

    await expect(
      repairRun({
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "run.repair_integrity_error" });
    expect(await snapshotTree(join(fixture.projectRoot, ".ai-qa"))).toEqual(
      before,
    );
  });

  it.each(["populated", "empty"] as const)(
    "resumes after a crash leaves a %s evidence deletion claim",
    async (claimState) => {
      const fixture = await createRepairFixture({ orphan: true });
      const orphan = requiredOrphan(fixture);
      const manifest = await orphanManifest(fixture);
      await writeManifest(fixture.projectRoot, manifest);
      await applyRecoveryCopies(fixture.projectRoot, manifest);
      await writeFile(evidenceIndexPath(fixture.projectRoot), "");
      const claimDirectory = evidenceDeletionClaimDirectory(
        fixture.projectRoot,
        orphan.id,
      );
      await mkdir(claimDirectory, { recursive: true });
      const source = resolveProjectPath(
        fixture.projectRoot,
        orphan.projectRelativePath,
      );
      if (claimState === "populated") {
        await rename(source, join(claimDirectory, "entry"));
      } else {
        await unlink(source);
      }

      await expect(
        repairRun({
          projectRoot: fixture.projectRoot,
          runId,
          now: fixedNow,
        }),
      ).resolves.toMatchObject({
        runId,
        relocated: [
          { kind: "evidence-file", reference: orphan.id },
          { kind: "evidence-index-entry", reference: orphan.id },
        ],
      });

      await expect(lstat(claimDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await readFile(evidenceIndexPath(fixture.projectRoot), "utf8"),
      ).toBe("");
      expect((await readManifest(fixture.projectRoot)).completedAt).toBe(
        fixedNow().toISOString(),
      );
    },
  );

  it("rejects a recovery temp pathname replaced after final verification", async () => {
    const fixture = await createRepairFixture({ orphan: true });
    const orphan = requiredOrphan(fixture);
    const source = resolveProjectPath(
      fixture.projectRoot,
      orphan.projectRelativePath,
    );
    const indexBefore = await readFile(evidenceIndexPath(fixture.projectRoot));
    const journalBefore = await readFile(journalPath(fixture.projectRoot));
    let recoveryPath: string | undefined;

    await expect(
      repairRun(
        {
          projectRoot: fixture.projectRoot,
          runId,
          now: fixedNow,
        },
        {
          hooks: {
            afterRecoveryPublishFinalVerification: async (input) => {
              recoveryPath = input.recoveryPath;
              await unlink(input.temporaryPath);
              await writeFile(input.temporaryPath, "replacement bytes");
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });

    expect(recoveryPath).toBeDefined();
    await expect(
      lstat(resolveProjectPath(fixture.projectRoot, recoveryPath!)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source, "utf8")).toBe("orphaned-image");
    expect(await readFile(evidenceIndexPath(fixture.projectRoot))).toEqual(
      indexBefore,
    );
    expect(await readFile(journalPath(fixture.projectRoot))).toEqual(
      journalBefore,
    );
  });

  it("rejects a recovery parent replaced after final verification", async () => {
    const fixture = await createRepairFixture({ orphan: true });
    const orphan = requiredOrphan(fixture);
    const source = resolveProjectPath(
      fixture.projectRoot,
      orphan.projectRelativePath,
    );
    const indexBefore = await readFile(evidenceIndexPath(fixture.projectRoot));
    const journalBefore = await readFile(journalPath(fixture.projectRoot));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-publish-swap-"));
    let outsideDestination: string | undefined;

    await expect(
      repairRun(
        {
          projectRoot: fixture.projectRoot,
          runId,
          now: fixedNow,
        },
        {
          hooks: {
            afterRecoveryPublishFinalVerification: async ({
              recoveryPath,
              temporaryPath,
              parentPath,
            }) => {
              await rename(parentPath, `${parentPath}.displaced`);
              await symlink(outside, parentPath, "dir");
              await writeFile(
                join(outside, basename(temporaryPath)),
                "replacement bytes",
              );
              outsideDestination = join(outside, basename(recoveryPath));
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });

    expect(outsideDestination).toBeDefined();
    await expect(lstat(outsideDestination!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(source, "utf8")).toBe("orphaned-image");
    expect(await readFile(evidenceIndexPath(fixture.projectRoot))).toEqual(
      indexBefore,
    );
    expect(await readFile(journalPath(fixture.projectRoot))).toEqual(
      journalBefore,
    );
  });

  it("rejects recovery bytes mutated on the published inode after link", async () => {
    const fixture = await createRepairFixture({ orphan: true });
    const orphan = requiredOrphan(fixture);
    const source = resolveProjectPath(
      fixture.projectRoot,
      orphan.projectRelativePath,
    );
    const indexBefore = await readFile(evidenceIndexPath(fixture.projectRoot));
    const journalBefore = await readFile(journalPath(fixture.projectRoot));
    let recoveryPath: string | undefined;

    await expect(
      repairRun(
        {
          projectRoot: fixture.projectRoot,
          runId,
          now: fixedNow,
        },
        {
          hooks: {
            afterRecoveryPublishLink: async (input) => {
              recoveryPath = input.recoveryPath;
              await writeFile(input.destinationPath, "mutated-image!");
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });

    expect(recoveryPath).toBeDefined();
    await expect(
      lstat(resolveProjectPath(fixture.projectRoot, recoveryPath!)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source, "utf8")).toBe("orphaned-image");
    expect(await readFile(evidenceIndexPath(fixture.projectRoot))).toEqual(
      indexBefore,
    );
    expect(await readFile(journalPath(fixture.projectRoot))).toEqual(
      journalBefore,
    );
  });

  it("preserves a source swapped to an outside symlink before deletion", async () => {
    const fixture = await createRepairFixture({ orphan: true });
    const orphan = requiredOrphan(fixture);
    const source = resolveProjectPath(
      fixture.projectRoot,
      orphan.projectRelativePath,
    );
    const displaced = `${source}.displaced`;
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-repair-swap-"));
    const outsideFile = join(outside, "outside.png");
    await writeFile(outsideFile, "outside bytes");

    let thrown: unknown;
    try {
      await repairRun(
        {
          projectRoot: fixture.projectRoot,
          runId,
          now: fixedNow,
        },
        {
          hooks: {
            afterEvidenceDeleteFinalVerification: async () => {
              await rename(source, displaced);
              await symlink(outsideFile, source);
            },
          },
        },
      );
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "storage.recovery_required" });
    expect(await readFile(displaced, "utf8")).toBe("orphaned-image");
    expect(await readFile(outsideFile, "utf8")).toBe("outside bytes");
    if (
      !(thrown instanceof Error) ||
      !("details" in thrown) ||
      typeof (thrown as { details?: { recoveryPath?: unknown } }).details
        ?.recoveryPath !== "string"
    ) {
      throw new Error("Expected a retained project-local removal claim");
    }
    const recoveryPath = (thrown as { details: { recoveryPath: string } })
      .details.recoveryPath;
    expect(await readlink(join(fixture.projectRoot, recoveryPath))).toBe(
      outsideFile,
    );
  });

  it("durably publishes recovery state before destructive repair steps", async () => {
    const fixture = await createRepairFixture({ orphan: true, torn: true });
    const order: string[] = [];

    await repairRun(
      {
        projectRoot: fixture.projectRoot,
        runId,
        now: fixedNow,
      },
      {
        hooks: {
          afterDurablePublish: ({ step }) => {
            order.push(`published:${step}`);
          },
          beforeDestructiveCommit: ({ step }) => {
            order.push(`destructive:${step}`);
          },
        },
      },
    );

    expect(order).toEqual([
      "published:recovery-ancestors",
      "published:repair-manifest-planned",
      "published:evidence-file",
      "published:evidence-index-entry",
      "published:journal-tail",
      "published:evidence-index",
      "destructive:journal-truncate",
      "published:evidence-deletion-claim",
      "destructive:evidence-delete",
      "published:evidence-deletion-claimed",
      "published:evidence-deletion-unlinked",
      "published:repair-manifest-completed",
    ]);
  });
});

async function createRepairFixture(
  options: { orphan?: boolean; torn?: boolean } = {},
): Promise<RepairFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-repair-"));
  await initializeTestProject({ projectRoot });
  const repository = new RunRepository(projectRoot, fixedNow);
  await repository.create(
    createExploratoryWorkOrder({
      platform: "web",
      projectId: "sample-web",
      runId,
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
  const protocol = new RunProtocolService(projectRoot, runId, fixedNow);
  const capture = await protocol.planAction({
    idempotencyKey: "capture-home",
    kind: "evidence-capture",
    intent: "Capture the authenticated home",
    tool: "chrome-devtools-mcp",
    target: { description: "Authenticated home" },
  });
  await protocol.completeAction({
    actionId: capture.event.id,
    phase: "completed",
    toolResult: { summary: "Screenshot captured" },
  });
  const sourcePath = join(projectRoot, "orphaned.png");
  await writeFile(sourcePath, "orphaned-image");
  let orphan: EvidenceRecord | undefined;
  if (options.orphan === true) {
    orphan = await registerEvidence({
      projectRoot,
      runId,
      payload: {
        sourcePath,
        mediaType: "image/png",
        sourceTool: "chrome-devtools-mcp",
        sensitivity: "internal",
        evidenceKinds: ["post-action-screenshot"],
        captureActionId: capture.event.id,
        idempotencyKey: "orphaned-evidence",
      },
      criterionIds: ["authenticated-home-visible"],
      observationIds: [],
      now: fixedNow,
    });
    const lines = (await readFile(journalPath(projectRoot), "utf8"))
      .trimEnd()
      .split("\n");
    const last = JSON.parse(lines.at(-1)!) as {
      type?: string;
      payload?: { id?: string };
    };
    expect(last).toMatchObject({
      type: "evidence",
      payload: { id: orphan.id },
    });
    await writeFile(
      journalPath(projectRoot),
      `${lines.slice(0, -1).join("\n")}\n`,
      "utf8",
    );
  }
  const cleanJournal = await readFile(journalPath(projectRoot));
  if (options.torn === true) {
    await appendFile(journalPath(projectRoot), tornBytes);
  }
  return {
    projectRoot,
    repository,
    captureActionId: capture.event.id,
    sourcePath,
    ...(orphan === undefined ? {} : { orphan }),
    cleanJournal,
  };
}

function requiredOrphan(fixture: RepairFixture): EvidenceRecord {
  if (fixture.orphan === undefined) throw new Error("missing orphan fixture");
  return fixture.orphan;
}

function journalPath(projectRoot: string): string {
  return join(projectRoot, ".ai-qa", "runs", runId, "events.jsonl");
}

function evidenceIndexPath(projectRoot: string): string {
  return join(projectRoot, ".ai-qa", "evidence", runId, "index.jsonl");
}

function recoveryDirectory(projectRoot: string): string {
  return join(projectRoot, ".ai-qa", "recovery", runId);
}

function evidenceDeletionClaimDirectory(
  projectRoot: string,
  evidenceId: string,
): string {
  return join(recoveryDirectory(projectRoot), "deletion-claims", evidenceId);
}

function manifestPath(projectRoot: string): string {
  return join(recoveryDirectory(projectRoot), "repair-manifest.json");
}

function resolveProjectPath(projectRoot: string, path: string): string {
  return join(projectRoot, ...path.split("/"));
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function serializeManifest(manifest: StoredRepairManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function writeManifest(
  projectRoot: string,
  manifest: StoredRepairManifest,
): Promise<void> {
  await mkdir(recoveryDirectory(projectRoot), { recursive: true });
  await writeFile(manifestPath(projectRoot), serializeManifest(manifest));
}

async function readManifest(
  projectRoot: string,
): Promise<StoredRepairManifest> {
  return JSON.parse(
    await readFile(manifestPath(projectRoot), "utf8"),
  ) as StoredRepairManifest;
}

function emptyIncompleteManifest(): StoredRepairManifest {
  return {
    schemaVersion: 1,
    runId,
    createdAt: fixedNow().toISOString(),
    relocations: [],
    orphanedEvidenceIds: [],
  };
}

async function orphanManifest(
  fixture: RepairFixture,
): Promise<StoredRepairManifest> {
  return evidenceManifest(fixture, requiredOrphan(fixture));
}

async function evidenceManifest(
  fixture: RepairFixture,
  evidence: EvidenceRecord,
): Promise<StoredRepairManifest> {
  const indexLine = Buffer.from(`${JSON.stringify(evidence)}\n`);
  const fileBytes = await readFile(
    resolveProjectPath(fixture.projectRoot, evidence.projectRelativePath),
  );
  return {
    schemaVersion: 1,
    runId,
    createdAt: fixedNow().toISOString(),
    relocations: [
      {
        kind: "evidence-file",
        evidenceId: evidence.id,
        sourcePath: evidence.projectRelativePath,
        recoveryPath: `.ai-qa/recovery/${runId}/evidence/files/${basename(
          evidence.projectRelativePath,
        )}`,
        contentHash: sha256(fileBytes),
      },
      {
        kind: "evidence-index-entry",
        evidenceId: evidence.id,
        sourcePath: `.ai-qa/evidence/${runId}/index.jsonl`,
        recoveryPath: `.ai-qa/recovery/${runId}/evidence/index/${evidence.id}.jsonl`,
        contentHash: sha256(indexLine),
      },
    ],
    orphanedEvidenceIds: [evidence.id],
  };
}

async function registerLiveEvidence(
  fixture: RepairFixture,
  idempotencyKey: string,
): Promise<EvidenceRecord> {
  return registerEvidence({
    projectRoot: fixture.projectRoot,
    runId,
    payload: {
      sourcePath: fixture.sourcePath,
      mediaType: "image/png",
      sourceTool: "chrome-devtools-mcp",
      sensitivity: "internal",
      evidenceKinds: ["post-action-screenshot"],
      captureActionId: fixture.captureActionId,
      idempotencyKey,
    },
    criterionIds: ["authenticated-home-visible"],
    observationIds: [],
    now: fixedNow,
  });
}

async function addOrphanIndexRecord(
  fixture: RepairFixture,
  template: EvidenceRecord,
  suffix: string,
): Promise<EvidenceRecord> {
  const id = `evidence-${randomUUID()}`;
  const projectRelativePath = `.ai-qa/evidence/${runId}/files/${id}-${suffix}.png`;
  const bytes = Buffer.from(`orphan-${suffix}`);
  await writeFile(
    resolveProjectPath(fixture.projectRoot, projectRelativePath),
    bytes,
  );
  const orphan: EvidenceRecord = {
    ...template,
    id,
    idempotencyKey: `orphan-${suffix}`,
    projectRelativePath,
    contentHash: sha256(bytes),
  };
  const existing = await readFile(
    evidenceIndexPath(fixture.projectRoot),
    "utf8",
  );
  await writeFile(
    evidenceIndexPath(fixture.projectRoot),
    `${existing}${JSON.stringify(orphan)}\n`,
  );
  return orphan;
}

async function cloneProject(sourceRoot: string): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-run-repair-clone-"));
  await cp(join(sourceRoot, ".ai-qa"), join(projectRoot, ".ai-qa"), {
    recursive: true,
  });
  return projectRoot;
}

async function applyRecoveryCopies(
  projectRoot: string,
  manifest: StoredRepairManifest,
): Promise<void> {
  for (const relocation of manifest.relocations) {
    let bytes: Buffer;
    switch (relocation.kind) {
      case "evidence-file":
        bytes = await readFile(
          resolveProjectPath(projectRoot, relocation.sourcePath),
        );
        break;
      case "evidence-index-entry": {
        const records = await readEvidenceIndex(projectRoot);
        const record = records.find(
          (candidate) => candidate.id === relocation.evidenceId,
        );
        if (record === undefined) throw new Error("missing orphan index row");
        bytes = Buffer.from(`${JSON.stringify(record)}\n`);
        break;
      }
      case "journal-tail": {
        const tail = manifest.journalTail;
        if (tail === undefined) throw new Error("missing torn-tail plan");
        const journal = await readFile(
          resolveProjectPath(projectRoot, relocation.sourcePath),
        );
        bytes = journal.subarray(
          tail.truncateOffset,
          tail.truncateOffset + tail.byteLength,
        );
        break;
      }
    }
    expect(sha256(bytes)).toBe(relocation.contentHash);
    const destination = resolveProjectPath(
      projectRoot,
      relocation.recoveryPath,
    );
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

async function applyIndexRewrite(
  projectRoot: string,
  manifest: StoredRepairManifest,
): Promise<void> {
  const orphaned = new Set(manifest.orphanedEvidenceIds);
  const retained = (await readEvidenceIndex(projectRoot)).filter(
    (record) => !orphaned.has(record.id),
  );
  await writeFile(
    evidenceIndexPath(projectRoot),
    retained.length === 0
      ? ""
      : `${retained.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

async function applyJournalTruncate(
  projectRoot: string,
  manifest: StoredRepairManifest,
): Promise<void> {
  if (manifest.journalTail !== undefined) {
    await truncate(
      journalPath(projectRoot),
      manifest.journalTail.truncateOffset,
    );
  }
}

async function applySourceDeletes(
  projectRoot: string,
  manifest: StoredRepairManifest,
): Promise<void> {
  for (const relocation of manifest.relocations) {
    if (relocation.kind === "evidence-file") {
      await rm(resolveProjectPath(projectRoot, relocation.sourcePath));
    }
  }
}

async function readEvidenceIndex(
  projectRoot: string,
): Promise<EvidenceRecord[]> {
  const content = await readFile(evidenceIndexPath(projectRoot), "utf8");
  return content.length === 0
    ? []
    : content
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as EvidenceRecord);
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  await walk(root, "");
  return snapshot;

  async function walk(path: string, relativePath: string): Promise<void> {
    const stats = await lstat(path);
    const key = relativePath.length === 0 ? "." : relativePath;
    if (stats.isSymbolicLink()) {
      snapshot[key] = `symlink:${await readlink(path)}`;
      return;
    }
    if (stats.isDirectory()) {
      snapshot[key] = "directory";
      const entries = (await readdir(path)).sort();
      for (const entry of entries) {
        await walk(join(path, entry), join(relativePath, entry));
      }
      return;
    }
    if (stats.isFile()) {
      snapshot[key] = `file:${(await readFile(path)).toString("base64")}`;
      return;
    }
    snapshot[key] = "other";
  }
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await lstat(path);
      return;
    } catch (error: unknown) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )) {
        throw error;
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${path}`);
}
