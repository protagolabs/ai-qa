import { canonicalJson } from "../../core/canonical-json.js";
import { readProjectConfig } from "../../core/config/repository.js";
import { AiQaError } from "../../core/errors.js";
import { createId } from "../../core/ids.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  type ExploratoryRunInput,
} from "../../core/runs/schema.js";
import type { DoctorCheck, WebDoctorResult } from "../doctor/web-doctor.js";
import { resolveTrustedProject } from "../project-root/resolve-trusted-project.js";
import { finalizeRun } from "./finalize-run.js";
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

export async function createPreflightResultRun(input: {
  projectRoot: string;
  aiQaHome: string;
  kind: "exploratory";
  exploratoryPayload: ExploratoryRunInput;
  execution: "local";
  readiness: NotReadyWebDoctorResult;
  now: () => Date;
}): Promise<PreflightResult> {
  if (input.kind !== "exploratory" || input.execution !== "local") {
    throw new AiQaError(
      "preflight.unsupported_run",
      "Increment 1 preflight results require local exploratory execution",
    );
  }
  const trusted = await resolveTrustedProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
    aiQaHome: input.aiQaHome,
  });
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

  const runId = createId("run");
  const workOrder = createExploratoryWorkOrder({
    projectId: config.project.id,
    runId,
    input: payload,
    evidencePolicy: {
      screenshots: config.evidencePolicy.screenshots,
      defaultSensitivity: config.evidencePolicy.defaultSensitivity,
    },
    startedAt: input.now(),
    preflightResult: true,
  });
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
