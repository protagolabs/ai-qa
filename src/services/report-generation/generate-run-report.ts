import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  calculateCaseContentHash,
  calculateWebVariantHash,
} from "../../core/cases/schema.js";
import { CaseRepository } from "../../core/cases/repository.js";
import { canonicalJson } from "../../core/canonical-json.js";
import { readProjectConfig } from "../../core/config/repository.js";
import type { ProjectConfig } from "../../core/config/schema.js";
import { validateEvidenceParity } from "../../core/evidence/parity.js";
import { EvidenceRepository } from "../../core/evidence/repository.js";
import { AiQaError } from "../../core/errors.js";
import { atomicWriteFile } from "../../core/fs/atomic-write.js";
import { runReportSchema, type RunReport } from "../../core/reports/schema.js";
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
  runIdSchema,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import {
  blockerPayloadSchema,
  type VerdictPayload,
  verdictPayloadSchema,
} from "../../core/verdicts/schema.js";
import { resolveTrustedProject } from "../project-root/resolve-trusted-project.js";
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

interface ReportOperationInput {
  projectRoot: string;
  aiQaHome: string;
  runId: string;
  now: () => Date;
}

interface VerifiedRunReport {
  projectRoot: string;
  config: ProjectConfig;
  report: RunReport;
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
  const directory = await verifiedReportDirectory(
    verified.projectRoot,
    input.runId,
    true,
  );
  const writes: Promise<void>[] = [];
  if (paths.jsonPath !== undefined) {
    writes.push(atomicWriteFile(resolve(directory, "report.json"), json));
  }
  if (paths.markdownPath !== undefined) {
    writes.push(atomicWriteFile(resolve(directory, "report.md"), markdown));
  }
  await Promise.all(writes);
  return { report: verified.report, ...paths };
}

export async function exportProjectLocalRunReport(
  input: ReportOperationInput,
): Promise<ProjectLocalReportPaths> {
  const verified = await buildVerifiedRunReport(input);
  const paths = reportPaths(input.runId, verified.config);
  const directory = await verifiedReportDirectory(
    verified.projectRoot,
    input.runId,
    false,
  );
  let persistedJson: RunReport | undefined;
  if (paths.jsonPath !== undefined) {
    const path = resolve(directory, "report.json");
    await requireRegularReportFile(path, input.runId, paths.jsonPath);
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
    const path = resolve(directory, "report.md");
    await requireRegularReportFile(path, input.runId, paths.markdownPath);
    const markdown = await readFile(path, "utf8");
    const expectedReport =
      persistedJson ?? reportWithMarkdownTimestamps(verified.report, markdown);
    if (markdown !== renderRunReportMarkdown(expectedReport)) {
      throw reportIntegrityError(input.runId, paths.markdownPath);
    }
  }
  return paths;
}

async function buildVerifiedRunReport(
  input: ReportOperationInput,
): Promise<VerifiedRunReport> {
  const runId = runIdSchema.parse(input.runId);
  const trusted = await resolveTrustedProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
    aiQaHome: input.aiQaHome,
  });
  const config = await readProjectConfig(trusted.projectRoot);
  const repository = new RunRepository(trusted.projectRoot, input.now);
  const report = await repository.journal(runId).readLocked(async (events) => {
    const workOrder = await repository.readVerifiedWorkOrder(runId);
    if (workOrder.projectId !== config.project.id) {
      throw new AiQaError(
        "work_order.integrity_error",
        "Work order project identity does not match project configuration",
        { runId, projectId: workOrder.projectId },
      );
    }
    const evidence = await new EvidenceRepository(
      trusted.projectRoot,
      runId,
      input.now,
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
    validateTerminalVerdict(phase, effective.payload, lifecycle.current.event);
    if (workOrder.kind === "regression") {
      await validatePinnedRegressionCase(
        trusted.projectRoot,
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
    return runReportSchema.parse({
      schemaVersion: 1,
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
  });
  return { projectRoot: trusted.projectRoot, config, report };
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

async function verifiedReportDirectory(
  projectRoot: string,
  runId: string,
  create: boolean,
): Promise<string> {
  runId = runIdSchema.parse(runId);
  const canonicalProjectRoot = await realpath(projectRoot);
  let directory = canonicalProjectRoot;
  for (const segment of [".ai-qa", "reports", "runs", runId]) {
    directory = resolve(directory, segment);
    if (create) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error: unknown) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
    }
    try {
      const stats = await lstat(directory);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (await realpath(directory)) !== directory
      ) {
        throw new Error("report storage ancestor is not a real directory");
      }
    } catch (error: unknown) {
      if (!create && isNodeError(error, "ENOENT")) {
        throw new AiQaError(
          "report.not_generated",
          "Configured project-local report output has not been generated",
          { runId },
        );
      }
      if (error instanceof AiQaError && error.code === "report.not_generated") {
        throw error;
      }
      throw new AiQaError(
        "report.storage_integrity_error",
        "Report storage must stay in real project-local directories",
        { runId, path: directory },
      );
    }
  }
  return directory;
}

async function requireRegularReportFile(
  path: string,
  runId: string,
  projectRelativePath: string,
): Promise<void> {
  try {
    const stats = await lstat(path);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      (await realpath(path)) !== path
    ) {
      throw new AiQaError(
        "report.storage_integrity_error",
        "Report artifacts must be real project-local files",
        { runId, path: projectRelativePath },
      );
    }
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    if (isNodeError(error, "ENOENT")) {
      throw new AiQaError(
        "report.not_generated",
        "Configured project-local report output has not been generated",
        { runId, path: projectRelativePath },
      );
    }
    throw new AiQaError(
      "report.storage_integrity_error",
      "Report artifact integrity verification failed",
      { runId, path: projectRelativePath },
    );
  }
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
      reason !== verdict.summary
    ) {
      throw new AiQaError(
        "run_protocol.integrity_error",
        "Cancelled lifecycle does not match its cancellation verdict",
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
  const platformVariantHash = calculateWebVariantHash(revision);
  if (
    pinned.caseContentHash !== caseContentHash ||
    pinned.platformVariantHash !== platformVariantHash
  ) {
    throw new AiQaError(
      "case.content_hash_mismatch",
      "Pinned regression case or Web variant hash verification failed",
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

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
