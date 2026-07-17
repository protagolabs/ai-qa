import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  calculateCaseContentHash,
  calculatePlatformVariantHash,
} from "../../core/cases/schema.js";
import { CaseRepository } from "../../core/cases/repository.js";
import { canonicalJson } from "../../core/canonical-json.js";
import { readProjectConfig } from "../../core/config/repository.js";
import type { ProjectConfig } from "../../core/config/schema.js";
import { validateEvidenceParity } from "../../core/evidence/parity.js";
import { EvidenceRepository } from "../../core/evidence/repository.js";
import { AiQaError } from "../../core/errors.js";
import { atomicWriteFile } from "../../core/fs/atomic-write.js";
import { controllerForPlatform } from "../../core/platforms/registry.js";
import { runReportSchema, type RunReport } from "../../core/reports/schema.js";
import {
  requireRunReportRegularFile,
  resolveRunReportDirectory,
  withRunReportLock,
} from "../../core/reports/storage.js";
import {
  actionPayloadSchema,
  assertionPayloadSchema,
  decisionPayloadSchema,
  evidenceEventPayloadSchema,
  observationPayloadSchema,
  recoveryPayloadSchema,
} from "../../core/runs/event-payloads.js";
import { validateRunLifecycleHistory } from "../../core/runs/lifecycle.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  effectiveWorkOrderRecordingMode,
  runIdSchema,
  type ProjectSkillSnapshot,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import {
  blockerPayloadSchema,
  type VerdictPayload,
  verdictPayloadSchema,
} from "../../core/verdicts/schema.js";
import { REPORT_SCHEMA_VERSION } from "../../schemas/versions.js";
import { resolveProject } from "../project-root/resolve-project.js";
import { validateProtocolEvents } from "../run-protocol/run-protocol-service.js";
import {
  effectiveVerdictFrom,
  validateVerdictHistory,
} from "../run-protocol/verdict-service.js";
import { renderRunReportMarkdown } from "./render-markdown.js";
import { validateFinalization } from "../run-protocol/finalize-run.js";

export interface GeneratedRunReport {
  report: RunReport;
  jsonPath?: string;
  markdownPath?: string;
}

export interface ProjectLocalReportPaths {
  jsonPath?: string;
  markdownPath?: string;
}

export interface ReportOperationInput {
  projectRoot: string;
  runId: string;
  now: () => Date;
}

interface VerifiedRunReport {
  projectRoot: string;
  config: ProjectConfig;
  recordingMode: "local-only" | "project-skill";
  projectSkill?: ProjectSkillSnapshot;
  report: RunReport;
}

export interface VerifiedGeneratedRunReport extends VerifiedRunReport {
  directory: string;
  paths: ProjectLocalReportPaths;
}

const summaryTimelineTypes = new Set<RunEvent["type"]>([
  "run",
  "blocker",
  "verdict",
  "assertion",
  "evidence",
]);

export async function generateRunReport(
  input: ReportOperationInput,
): Promise<GeneratedRunReport> {
  const verified = await buildVerifiedRunReport(input);
  const paths = reportPaths(input.runId, verified.config);
  const json = `${JSON.stringify(verified.report, null, 2)}\n`;
  const markdown = renderRunReportMarkdown(verified.report);
  const directory = await resolveRunReportDirectory({
    projectRoot: verified.projectRoot,
    runId: input.runId,
    create: true,
  });
  await withRunReportLock(directory, async () => {
    const configuredFilenames = [
      ...(paths.jsonPath === undefined ? [] : (["report.json"] as const)),
      ...(paths.markdownPath === undefined ? [] : (["report.md"] as const)),
    ];
    await Promise.all(
      configuredFilenames.map((filename) =>
        verifyOptionalExistingReportArtifact({
          directory,
          filename,
          runId: input.runId,
        }),
      ),
    );
    const writes: Promise<void>[] = [];
    if (paths.jsonPath !== undefined) {
      writes.push(atomicWriteFile(resolve(directory, "report.json"), json));
    }
    if (paths.markdownPath !== undefined) {
      writes.push(atomicWriteFile(resolve(directory, "report.md"), markdown));
    }
    await Promise.all(writes);
  });
  return { report: verified.report, ...paths };
}

export async function verifyRunReport(
  input: ReportOperationInput,
): Promise<RunReport> {
  return (await buildVerifiedRunReport(input)).report;
}

async function verifyOptionalExistingReportArtifact(input: {
  directory: string;
  filename: "report.json" | "report.md";
  runId: string;
}): Promise<void> {
  try {
    await requireRunReportRegularFile({
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

export async function exportProjectLocalRunReport(
  input: ReportOperationInput,
): Promise<ProjectLocalReportPaths> {
  return withVerifiedGeneratedRunReport(input, ({ paths }) =>
    Promise.resolve(paths),
  );
}

export async function withVerifiedGeneratedRunReport<T>(
  input: ReportOperationInput,
  operation: (verified: VerifiedGeneratedRunReport) => Promise<T>,
): Promise<T> {
  const verified = await buildVerifiedRunReport(input);
  const paths = reportPaths(input.runId, verified.config);
  const directory = await resolveRunReportDirectory({
    projectRoot: verified.projectRoot,
    runId: input.runId,
    create: false,
  });
  return withRunReportLock(directory, async () => {
    let persistedJson: RunReport | undefined;
    if (paths.jsonPath !== undefined) {
      const path = await requireRunReportRegularFile({
        directory,
        filename: "report.json",
        runId: input.runId,
        missingCode: "report.not_generated",
      });
      try {
        persistedJson = runReportSchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );
      } catch {
        throw reportIntegrityError(input.runId, paths.jsonPath);
      }
      if (
        persistedJson.run.id !== input.runId ||
        canonicalJson(stableReportContent(persistedJson)) !==
          canonicalJson(stableReportContent(verified.report))
      ) {
        throw reportIntegrityError(input.runId, paths.jsonPath);
      }
    }
    if (paths.markdownPath !== undefined) {
      const path = await requireRunReportRegularFile({
        directory,
        filename: "report.md",
        runId: input.runId,
        missingCode: "report.not_generated",
      });
      const markdown = await readFile(path, "utf8");
      const expectedReport =
        persistedJson ??
        reportWithMarkdownTimestamps(verified.report, markdown);
      if (markdown !== renderRunReportMarkdown(expectedReport)) {
        throw reportIntegrityError(input.runId, paths.markdownPath);
      }
    }
    return operation({ ...verified, directory, paths });
  });
}

async function buildVerifiedRunReport(
  input: ReportOperationInput,
): Promise<VerifiedRunReport> {
  const runId = runIdSchema.parse(input.runId);
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const config = await readProjectConfig(project.projectRoot);
  const repository = new RunRepository(project.projectRoot, input.now);
  const verified = await repository
    .journal(runId)
    .readLocked(async (events) => {
      const workOrder = await repository.readVerifiedWorkOrder(runId);
      if (workOrder.projectId !== config.project.id) {
        throw new AiQaError(
          "work_order.integrity_error",
          "Work order project identity does not match project configuration",
          { runId, projectId: workOrder.projectId },
        );
      }
      const evidence = await new EvidenceRepository(
        project.projectRoot,
        runId,
        input.now,
        workOrder.platform,
      ).verifyAll();
      validateEvidenceParity(events, evidence, runId);
      validateProtocolEvents(events, workOrder, runId);
      const effective = effectiveVerdictFrom(
        validateVerdictHistory(events, workOrder),
      );
      const lifecycle = validateRunLifecycleHistory(events, runId);
      const phase = lifecycle.current.payload.phase;
      if (phase !== "completed" && phase !== "cancelled") {
        throw new AiQaError(
          "report.run_not_terminal",
          "Only completed or cancelled runs can generate reports",
          { runId, status: phase },
        );
      }
      if (
        effective === undefined ||
        lifecycle.current.payload.verdictId !== effective.event.id
      ) {
        throw new AiQaError(
          "run_protocol.integrity_error",
          "Terminal run lifecycle does not match its effective verdict",
          { runId, effectiveVerdictId: effective?.event.id },
        );
      }
      if (events.at(-1)?.id !== lifecycle.current.event.id) {
        throw new AiQaError(
          "run_protocol.integrity_error",
          "Terminal lifecycle event must be the final run journal event",
          { runId, terminalEventId: lifecycle.current.event.id },
        );
      }
      validateTerminalVerdict(
        phase,
        effective.payload,
        lifecycle.current.event,
      );
      if (workOrder.kind === "regression") {
        await validatePinnedRegressionCase(
          project.projectRoot,
          workOrder,
          input.now,
        );
      }
      if (phase === "completed") {
        validateFinalization({
          workOrder,
          events,
          evidence,
          verdict: effective,
          completionTime: new Date(lifecycle.current.event.timestamp),
        });
      }

      const verificationTime = input.now().toISOString();
      const timelineEvents =
        config.reportPolicy.detail === "full"
          ? events
          : events.filter((event) => summaryTimelineTypes.has(event.type));
      const report = runReportSchema.parse({
        schemaVersion: REPORT_SCHEMA_VERSION,
        generatedAt: verificationTime,
        project: config.project,
        reportPolicy: {
          audience: config.reportPolicy.audience,
          detail: config.reportPolicy.detail,
        },
        run: {
          id: runId,
          kind: workOrder.kind,
          execution: workOrder.execution,
          platform: workOrder.platform,
          controller: controllerForPlatform(workOrder.platform),
          status: phase,
        },
        verdict: reportVerdict(effective.payload),
        workOrder: {
          goal: workOrder.goal,
          acceptanceCriteria: workOrder.acceptanceCriteria,
          evidencePolicy: workOrder.evidencePolicy,
          ...(workOrder.pinnedCase === undefined
            ? {}
            : { pinnedCase: workOrder.pinnedCase }),
        },
        evidence: evidence.map((record) => ({
          id: record.id,
          contentHash: record.contentHash,
          path: record.projectRelativePath,
          evidenceKinds: record.evidenceKinds,
          sourceTool: record.sourceTool,
        })),
        timeline: timelineEvents.map((event) => ({
          sequence: event.sequence,
          eventId: event.id,
          type: event.type,
          summary: eventSummary(event),
          relatedIds: event.relatedIds,
        })),
        integrity: {
          status: "verified",
          verifiedAt: verificationTime,
        },
      });
      return {
        recordingMode: effectiveWorkOrderRecordingMode(workOrder),
        ...(workOrder.projectSkill === undefined
          ? {}
          : { projectSkill: workOrder.projectSkill }),
        report,
      };
    });
  return { projectRoot: project.projectRoot, config, ...verified };
}

function reportPaths(
  runId: string,
  config: ProjectConfig,
): ProjectLocalReportPaths {
  runId = runIdSchema.parse(runId);
  const directory = `.ai-qa/reports/runs/${runId}`;
  const formats = new Set(config.reportPolicy.formats);
  return {
    ...(formats.has("json") ? { jsonPath: `${directory}/report.json` } : {}),
    ...(formats.has("markdown")
      ? { markdownPath: `${directory}/report.md` }
      : {}),
  };
}

function stableReportContent(report: RunReport): unknown {
  const { generatedAt, integrity, ...content } = report;
  void generatedAt;
  return { ...content, integrity: { status: integrity.status } };
}

function reportWithMarkdownTimestamps(
  report: RunReport,
  markdown: string,
): RunReport {
  const integrityMarker = "\n## Integrity\n\n";
  const integrityIndex = markdown.lastIndexOf(integrityMarker);
  const integrityFooter =
    integrityIndex < 0
      ? ""
      : markdown.slice(integrityIndex + integrityMarker.length);
  const verifiedAt = /^Verified at (.+)\.\n$/u.exec(integrityFooter)?.[1];
  if (verifiedAt === undefined) {
    throw reportIntegrityError(report.run.id, "report.md");
  }
  try {
    return runReportSchema.parse({
      ...report,
      generatedAt: verifiedAt,
      integrity: { status: "verified", verifiedAt },
    });
  } catch {
    throw reportIntegrityError(report.run.id, "report.md");
  }
}

function reportIntegrityError(runId: string, path: string): AiQaError {
  return new AiQaError(
    "report.integrity_error",
    "Generated report artifact does not match verified run state",
    { runId, path },
  );
}

function reportVerdict(payload: VerdictPayload): RunReport["verdict"] {
  const common = {
    summary: payload.summary,
    criterionResults: payload.criterionResults,
  };
  switch (payload.classification) {
    case "pass":
      return { classification: "pass", ...common };
    case "fail":
      return { classification: "fail", ...common };
    case "blocked":
      return {
        classification: "blocked",
        ...common,
        blockerSubtype: payload.blockerSubtype,
      };
    case "not_verified":
      return {
        classification: "not_verified",
        ...common,
        reasonCode: payload.reasonCode,
      };
  }
}

function validateTerminalVerdict(
  phase: "completed" | "cancelled",
  verdict: VerdictPayload,
  terminal: RunEvent,
): void {
  if (phase === "cancelled") {
    const reason = isRecord(terminal.payload) ? terminal.payload.reason : null;
    if (
      verdict.classification !== "not_verified" ||
      verdict.reasonCode !== "cancelled" ||
      verdict.criterionResults.length !== 0 ||
      reason !== verdict.summary
    ) {
      throw new AiQaError(
        "run_protocol.integrity_error",
        "Cancelled lifecycle does not match its canonical cancellation verdict",
        { runId: terminal.runId },
      );
    }
    return;
  }
  if (
    verdict.classification === "not_verified" &&
    verdict.reasonCode === "cancelled"
  ) {
    throw new AiQaError(
      "run_protocol.integrity_error",
      "Completed lifecycle cannot use a cancellation verdict",
      { runId: terminal.runId },
    );
  }
}

async function validatePinnedRegressionCase(
  projectRoot: string,
  workOrder: WorkOrder,
  now: () => Date,
): Promise<void> {
  const pinned = workOrder.pinnedCase;
  if (pinned === undefined) {
    throw new AiQaError(
      "work_order.integrity_error",
      "Regression work order is missing its pinned case",
      { runId: workOrder.runId },
    );
  }
  const revision = await new CaseRepository(projectRoot, now).validateRevision(
    pinned.caseId,
    pinned.revision,
  );
  const caseContentHash = calculateCaseContentHash(revision);
  const platformVariantHash = calculatePlatformVariantHash(
    revision,
    workOrder.platform,
  );
  if (
    pinned.caseContentHash !== caseContentHash ||
    pinned.platformVariantHash !== platformVariantHash
  ) {
    throw new AiQaError(
      "case.content_hash_mismatch",
      "Pinned regression case or platform variant hash verification failed",
      {
        caseId: pinned.caseId,
        revision: pinned.revision,
        expectedCaseContentHash: pinned.caseContentHash,
        actualCaseContentHash: caseContentHash,
        expectedPlatformVariantHash: pinned.platformVariantHash,
        actualPlatformVariantHash: platformVariantHash,
      },
    );
  }
}

function eventSummary(event: RunEvent): string {
  let value: string;
  switch (event.type) {
    case "run": {
      const phase =
        isRecord(event.payload) && typeof event.payload.phase === "string"
          ? event.payload.phase
          : canonicalJson(event.payload);
      const reason =
        isRecord(event.payload) && typeof event.payload.reason === "string"
          ? `: ${event.payload.reason}`
          : "";
      value = `Run ${phase}${reason}`;
      break;
    }
    case "action": {
      const payload = actionPayloadSchema.parse(event.payload);
      value =
        payload.phase === "planned"
          ? `Action planned (${payload.kind}): ${payload.intent}`
          : `Action ${payload.phase}: ${payload.toolResult.summary}`;
      break;
    }
    case "observation":
      value = observationPayloadSchema.parse(event.payload).summary;
      break;
    case "assertion": {
      const payload = assertionPayloadSchema.parse(event.payload);
      value = `Assertion ${payload.criterionId}: ${payload.status} — ${payload.actual}`;
      break;
    }
    case "evidence": {
      const payload = evidenceEventPayloadSchema.parse(event.payload);
      value = `Evidence ${payload.id}: ${payload.evidenceKinds.join(", ")}`;
      break;
    }
    case "decision":
      value = decisionPayloadSchema.parse(event.payload).rationale;
      break;
    case "blocker":
      value = blockerPayloadSchema.parse(event.payload).condition;
      break;
    case "verdict":
      value = verdictPayloadSchema.parse(event.payload).summary;
      break;
    case "recovery":
      value = recoveryPayloadSchema.parse(event.payload).rationale;
      break;
  }
  return value.replace(/\s+/gu, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
