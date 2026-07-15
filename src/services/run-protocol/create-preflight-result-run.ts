import { canonicalJson } from "../../core/canonical-json.js";
import { readProjectConfig } from "../../core/config/repository.js";
import { AiQaError } from "../../core/errors.js";
import { createId } from "../../core/ids.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  type ExploratoryRunInput,
  type WorkOrder,
} from "../../core/runs/schema.js";
import type { DoctorCheck, WebDoctorResult } from "../doctor/web-doctor.js";
import { resolveTrustedProject } from "../project-root/resolve-trusted-project.js";
import { finalizeRun } from "./finalize-run.js";
import { prepareRegressionWorkOrder } from "./start-regression-run.js";
import { VerdictService } from "./verdict-service.js";

type NotReadyWebDoctorResult = WebDoctorResult & { status: "not_ready" };

export type PreflightResult =
  | {
      runId: string;
      status: "completed";
      verdict: "blocked";
      blockerSubtype: "tool" | "environment";
    }
  | {
      runId: string;
      status: "completed";
      verdict: "not_verified";
      reasonCode: "incomplete_coverage";
    };

type PreflightResultRunInput = {
  projectRoot: string;
  aiQaHome: string;
  readiness: NotReadyWebDoctorResult;
  now: () => Date;
} & (
  | {
      kind: "exploratory";
      exploratoryPayload: ExploratoryRunInput;
      execution: "local";
    }
  | {
      kind: "regression";
      caseId: string;
      execution: "local" | "ci";
    }
);

export async function createPreflightResultRun(
  input: PreflightResultRunInput,
): Promise<PreflightResult> {
  const trusted = await resolveTrustedProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
    aiQaHome: input.aiQaHome,
  });
  if (input.readiness.status !== "not_ready") {
    throw new AiQaError(
      "preflight.readiness_mismatch",
      "Preflight requires a not-ready doctor result",
    );
  }

  let workOrder: WorkOrder;
  if (input.kind === "exploratory") {
    const config = await readProjectConfig(trusted.projectRoot);
    const payload = exploratoryRunInputSchema.parse(input.exploratoryPayload);
    if (
      payload.readiness.status !== "not_ready" ||
      canonicalJson(payload.readiness) !== canonicalJson(input.readiness)
    ) {
      throw new AiQaError(
        "preflight.readiness_mismatch",
        "Preflight payload must contain the same not-ready doctor result",
      );
    }
    workOrder = createExploratoryWorkOrder({
      projectId: config.project.id,
      runId: createId("run"),
      input: payload,
      evidencePolicy: {
        screenshots: config.evidencePolicy.screenshots,
        defaultSensitivity: config.evidencePolicy.defaultSensitivity,
      },
      recordingPolicy: config.recordingPolicy,
      startedAt: input.now(),
      preflightResult: true,
    }) as WorkOrder;
  } else {
    workOrder = (
      await prepareRegressionWorkOrder({
        projectRoot: trusted.projectRoot,
        aiQaHome: input.aiQaHome,
        caseId: input.caseId,
        execution: input.execution,
        readiness: input.readiness,
        now: input.now,
        preflightResult: true,
      })
    ).workOrder;
  }
  const runId = workOrder.runId;
  const repository = new RunRepository(trusted.projectRoot, input.now);
  const { journal } = await repository.create(workOrder);
  const started = (await journal.readAll())[0];
  if (started === undefined) {
    throw new AiQaError(
      "run_protocol.integrity_error",
      "Preflight run is missing its start anchor",
      { runId },
    );
  }
  const verdicts = new VerdictService(
    trusted.projectRoot,
    input.aiQaHome,
    runId,
    input.now,
  );
  const failedChecks = input.readiness.checks.filter(
    (check) => check.status === "fail",
  );

  if (failedChecks.length > 0) {
    const blockerSubtype = classifyFailedChecks(failedChecks);
    const blocker = await verdicts.recordBlocker({
      subtype: blockerSubtype,
      condition: failedChecks
        .map((check) => `${check.code}: ${check.message}`)
        .join("; "),
      attemptEventIds: [started.id],
      criterionIds: [],
    });
    await verdicts.set({
      classification: "blocked",
      blockerSubtype,
      blockerIds: [blocker.id],
      summary: "Preflight checks prevented Web QA execution",
      criterionResults: [],
    });
    await finalizeRun({
      projectRoot: trusted.projectRoot,
      aiQaHome: input.aiQaHome,
      runId,
      now: input.now,
    });
    return { runId, status: "completed", verdict: "blocked", blockerSubtype };
  }

  await verdicts.set({
    classification: "not_verified",
    reasonCode: "incomplete_coverage",
    summary: "Agent confirmation is required before Web QA can execute",
    criterionResults: [],
  });
  await finalizeRun({
    projectRoot: trusted.projectRoot,
    aiQaHome: input.aiQaHome,
    runId,
    now: input.now,
  });
  return {
    runId,
    status: "completed",
    verdict: "not_verified",
    reasonCode: "incomplete_coverage",
  };
}

function classifyFailedChecks(
  checks: readonly DoctorCheck[],
): "tool" | "environment" {
  return checks.some(
    (check) =>
      check.code === "agent.global_skill" ||
      check.code === "web.chrome_devtools_mcp",
  )
    ? "tool"
    : "environment";
}
