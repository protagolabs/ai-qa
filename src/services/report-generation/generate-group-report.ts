import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson } from "../../core/canonical-json.js";
import { readProjectConfig } from "../../core/config/repository.js";
import type { ProjectConfig } from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import { atomicWriteFile } from "../../core/fs/atomic-write.js";
import {
  runGroupReportSchema,
  type RunGroupReport,
  type RunGroupReportCell,
} from "../../core/reports/group-schema.js";
import {
  requireGroupReportRegularFile,
  resolveGroupReportDirectory,
  withGroupReportLock,
} from "../../core/reports/storage.js";
import { RunGroupRepository } from "../../core/run-groups/repository.js";
import {
  runGroupIdSchema,
  type RunGroupManifest,
} from "../../core/run-groups/schema.js";
import {
  effectiveWorkOrderRecordingMode,
  type ProjectSkillSnapshot,
} from "../../core/runs/schema.js";
import { REPORT_SCHEMA_VERSION } from "../../schemas/versions.js";
import { resolveProject } from "../project-root/resolve-project.js";
import { readVerifiedRunGroupMemberStates } from "../run-groups/finish-run-group.js";
import {
  verifyRunReport,
  type ProjectLocalReportPaths,
} from "./generate-run-report.js";
import { renderRunGroupReportMarkdown } from "./render-group-markdown.js";

export interface GroupReportOperationInput {
  projectRoot: string;
  runGroupId: string;
  now: () => Date;
}

export interface GeneratedRunGroupReport {
  report: RunGroupReport;
  jsonPath?: string;
  markdownPath?: string;
}

interface VerifiedRunGroupReport {
  projectRoot: string;
  config: ProjectConfig;
  recordingMode: "local-only" | "project-skill";
  projectSkill?: ProjectSkillSnapshot;
  report: RunGroupReport;
}

export interface VerifiedGeneratedRunGroupReport extends VerifiedRunGroupReport {
  directory: string;
  paths: ProjectLocalReportPaths;
}

export async function generateRunGroupReport(
  input: GroupReportOperationInput,
): Promise<GeneratedRunGroupReport> {
  const verified = await buildVerifiedRunGroupReport(input);
  const paths = groupReportPaths(input.runGroupId, verified.config);
  const directory = await resolveGroupReportDirectory({
    projectRoot: verified.projectRoot,
    runGroupId: input.runGroupId,
    create: true,
  });
  await withGroupReportLock(directory, async () => {
    const filenames = [
      ...(paths.jsonPath === undefined ? [] : (["report.json"] as const)),
      ...(paths.markdownPath === undefined ? [] : (["report.md"] as const)),
    ];
    await Promise.all(
      filenames.map((filename) =>
        verifyOptionalExistingGroupArtifact({
          directory,
          filename,
          runGroupId: input.runGroupId,
        }),
      ),
    );
    const writes: Promise<void>[] = [];
    if (paths.jsonPath !== undefined) {
      writes.push(
        atomicWriteFile(
          resolve(directory, "report.json"),
          `${JSON.stringify(verified.report, null, 2)}\n`,
        ),
      );
    }
    if (paths.markdownPath !== undefined) {
      writes.push(
        atomicWriteFile(
          resolve(directory, "report.md"),
          renderRunGroupReportMarkdown(verified.report),
        ),
      );
    }
    await Promise.all(writes);
  });
  return { report: verified.report, ...paths };
}

export async function verifyRunGroupReport(
  input: GroupReportOperationInput,
): Promise<RunGroupReport> {
  return (await buildVerifiedRunGroupReport(input)).report;
}

export async function exportProjectLocalGroupReport(
  input: GroupReportOperationInput,
): Promise<ProjectLocalReportPaths> {
  return withVerifiedGeneratedRunGroupReport(input, ({ paths }) =>
    Promise.resolve(paths),
  );
}

export async function withVerifiedGeneratedRunGroupReport<T>(
  input: GroupReportOperationInput,
  operation: (verified: VerifiedGeneratedRunGroupReport) => Promise<T>,
): Promise<T> {
  const verified = await buildVerifiedRunGroupReport(input);
  const paths = groupReportPaths(input.runGroupId, verified.config);
  const directory = await resolveGroupReportDirectory({
    projectRoot: verified.projectRoot,
    runGroupId: input.runGroupId,
    create: false,
  });
  return withGroupReportLock(directory, async () => {
    let persistedJson: RunGroupReport | undefined;
    if (paths.jsonPath !== undefined) {
      const path = await requireGroupReportRegularFile({
        directory,
        filename: "report.json",
        runGroupId: input.runGroupId,
        missingCode: "report.not_generated",
      });
      try {
        persistedJson = runGroupReportSchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );
      } catch {
        throw groupReportIntegrityError(input.runGroupId, paths.jsonPath);
      }
      if (
        persistedJson.group.id !== input.runGroupId ||
        canonicalJson(stableGroupReportContent(persistedJson)) !==
          canonicalJson(stableGroupReportContent(verified.report))
      ) {
        throw groupReportIntegrityError(input.runGroupId, paths.jsonPath);
      }
    }
    if (paths.markdownPath !== undefined) {
      const path = await requireGroupReportRegularFile({
        directory,
        filename: "report.md",
        runGroupId: input.runGroupId,
        missingCode: "report.not_generated",
      });
      const markdown = await readFile(path, "utf8");
      const expected =
        persistedJson ??
        groupReportWithMarkdownTimestamps(verified.report, markdown);
      if (markdown !== renderRunGroupReportMarkdown(expected)) {
        throw groupReportIntegrityError(input.runGroupId, paths.markdownPath);
      }
    }
    return operation({ ...verified, directory, paths });
  });
}

async function buildVerifiedRunGroupReport(
  input: GroupReportOperationInput,
): Promise<VerifiedRunGroupReport> {
  const runGroupId = runGroupIdSchema.parse(input.runGroupId);
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const config = await readProjectConfig(project.projectRoot);
  const repository = new RunGroupRepository(project.projectRoot, input.now);
  return repository.readLocked(runGroupId, async ({ manifest, events }) => {
    const terminal = events.at(-1);
    if (
      terminal === undefined ||
      (terminal.payload.phase !== "completed" &&
        terminal.payload.phase !== "cancelled") ||
      !events.some((event) => event.payload.phase === "materialized")
    ) {
      throw new AiQaError(
        "report.group_not_terminal",
        "Only terminal materialized run groups can generate reports",
        { runGroupId, status: terminal?.payload.phase },
      );
    }
    const groupStatus = terminal.payload.phase;
    if (manifest.projectId !== config.project.id) {
      throw new AiQaError(
        "run_group.member_integrity_error",
        "Run-group project identity does not match project configuration",
        { runGroupId, projectId: manifest.projectId },
      );
    }
    const members = await readVerifiedRunGroupMemberStates({
      projectRoot: project.projectRoot,
      manifest,
      now: input.now,
    });
    const cells = new Map<string, RunGroupReportCell>();
    for (const { member } of members) {
      const report = await verifyRunReport({
        projectRoot: project.projectRoot,
        runId: member.runId,
        now: input.now,
      });
      const pinned = report.workOrder.pinnedCase;
      if (
        report.project.id !== manifest.projectId ||
        report.run.id !== member.runId ||
        report.run.kind !== "regression" ||
        report.run.execution !== manifest.execution ||
        report.run.platform !== member.platform ||
        pinned === undefined ||
        pinned.caseId !== member.caseId ||
        pinned.revision !== member.revision ||
        pinned.caseContentHash !== member.caseContentHash ||
        pinned.platformVariantHash !== member.platformVariantHash
      ) {
        throw new AiQaError(
          "run_group.member_integrity_error",
          "Verified child report does not match its immutable group member",
          { runGroupId, runId: member.runId },
        );
      }
      const identity = {
        caseId: member.caseId,
        revision: member.revision,
        caseContentHash: member.caseContentHash,
        platform: member.platform,
        runId: member.runId,
      };
      const verdict = report.verdict;
      cells.set(
        cellKey(member.caseId, member.platform),
        verdict.classification === "blocked"
          ? {
              ...identity,
              status: "blocked",
              blockerSubtype: verdict.blockerSubtype,
            }
          : verdict.classification === "not_verified"
            ? {
                ...identity,
                status: "not_verified",
                reasonCode: verdict.reasonCode,
              }
            : { ...identity, status: verdict.classification },
      );
    }
    for (const exclusion of manifest.exclusions) {
      cells.set(cellKey(exclusion.caseId, exclusion.platform), {
        caseId: exclusion.caseId,
        revision: exclusion.revision,
        caseContentHash: exclusion.caseContentHash,
        platform: exclusion.platform,
        status: "coverage_gap",
        reason: exclusion.reason,
      });
    }
    const caseIds = [
      ...new Set(
        [...manifest.members, ...manifest.exclusions].map(
          (entry) => entry.caseId,
        ),
      ),
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const matrix = caseIds.flatMap((caseId) =>
      manifest.selectedPlatforms.map((platform) => {
        const cell = cells.get(cellKey(caseId, platform));
        if (cell === undefined) {
          throw new AiQaError(
            "report.integrity_error",
            "Run-group manifest does not contain a complete selected matrix",
            { runGroupId, caseId, platform },
          );
        }
        return cell;
      }),
    );
    const generatedAt = input.now().toISOString();
    const report = runGroupReportSchema.parse({
      schemaVersion: REPORT_SCHEMA_VERSION,
      generatedAt,
      project: config.project,
      reportPolicy: {
        audience: config.reportPolicy.audience,
        detail: config.reportPolicy.detail,
      },
      group: {
        id: runGroupId,
        execution: manifest.execution,
        status: groupStatus,
        selectionMode: manifest.selectionMode,
        selectedPlatforms: manifest.selectedPlatforms,
        createdAt: manifest.createdAt,
      },
      matrix,
      summary: summarize(matrix),
      integrity: { status: "verified", verifiedAt: generatedAt },
    });
    return {
      projectRoot: project.projectRoot,
      config,
      ...recordingPolicy(manifest),
      report,
    };
  });
}

function recordingPolicy(manifest: RunGroupManifest): {
  recordingMode: "local-only" | "project-skill";
  projectSkill?: ProjectSkillSnapshot;
} {
  const recordingMode = manifest.recordingPolicy.mode;
  const projectSkill = manifest.projectSkill;
  if (
    manifest.members.some(
      (member) =>
        effectiveWorkOrderRecordingMode(member.workOrder) !== recordingMode ||
        canonicalJson(member.workOrder.projectSkill ?? null) !==
          canonicalJson(projectSkill ?? null),
    )
  ) {
    throw new AiQaError(
      "run_group.member_integrity_error",
      "Run-group members do not share one frozen recording policy",
      { runGroupId: manifest.id },
    );
  }
  return {
    recordingMode,
    ...(projectSkill === undefined ? {} : { projectSkill }),
  };
}

function summarize(matrix: readonly RunGroupReportCell[]) {
  return matrix.reduce(
    (summary, cell) => {
      switch (cell.status) {
        case "pass":
          summary.pass += 1;
          break;
        case "fail":
          summary.fail += 1;
          break;
        case "blocked":
          summary.blocked += 1;
          break;
        case "not_verified":
          summary.notVerified += 1;
          break;
        case "coverage_gap":
          summary.coverageGap += 1;
          break;
      }
      return summary;
    },
    { pass: 0, fail: 0, blocked: 0, notVerified: 0, coverageGap: 0 },
  );
}

function cellKey(caseId: string, platform: string): string {
  return `${caseId}\u0000${platform}`;
}

function groupReportPaths(
  runGroupId: string,
  config: ProjectConfig,
): ProjectLocalReportPaths {
  runGroupId = runGroupIdSchema.parse(runGroupId);
  const directory = `.ai-qa/reports/groups/${runGroupId}`;
  const formats = new Set(config.reportPolicy.formats);
  return {
    ...(formats.has("json") ? { jsonPath: `${directory}/report.json` } : {}),
    ...(formats.has("markdown")
      ? { markdownPath: `${directory}/report.md` }
      : {}),
  };
}

async function verifyOptionalExistingGroupArtifact(input: {
  directory: string;
  filename: "report.json" | "report.md";
  runGroupId: string;
}): Promise<void> {
  try {
    await requireGroupReportRegularFile({
      ...input,
      missingCode: "report.not_generated",
    });
  } catch (error: unknown) {
    if (error instanceof AiQaError && error.code === "report.not_generated") {
      return;
    }
    throw error;
  }
}

function stableGroupReportContent(report: RunGroupReport): unknown {
  const { generatedAt, integrity, ...content } = report;
  void generatedAt;
  return { ...content, integrity: { status: integrity.status } };
}

function groupReportWithMarkdownTimestamps(
  report: RunGroupReport,
  markdown: string,
): RunGroupReport {
  const marker = "\n## Integrity\n\n";
  const index = markdown.lastIndexOf(marker);
  const footer = index < 0 ? "" : markdown.slice(index + marker.length);
  const verifiedAt = /^Verified at (.+)\.\n$/u.exec(footer)?.[1];
  if (verifiedAt === undefined) {
    throw groupReportIntegrityError(report.group.id, "report.md");
  }
  try {
    return runGroupReportSchema.parse({
      ...report,
      generatedAt: verifiedAt,
      integrity: { status: "verified", verifiedAt },
    });
  } catch {
    throw groupReportIntegrityError(report.group.id, "report.md");
  }
}

function groupReportIntegrityError(
  runGroupId: string,
  path: string,
): AiQaError {
  return new AiQaError(
    "report.integrity_error",
    "Generated group report artifact does not match verified group state",
    { runGroupId, path },
  );
}
