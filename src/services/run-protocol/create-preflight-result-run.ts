import { canonicalJson } from "../../core/canonical-json.js";
import { readProjectConfig } from "../../core/config/repository.js";
import {
  configuredPlatforms,
  projectConfigSchema,
  type ProjectConfig,
} from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import { createId } from "../../core/ids.js";
import { RunRepository } from "../../core/runs/repository.js";
import type { PlatformReadiness } from "../../core/readiness/schema.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  type ExploratoryRunInput,
  type WorkOrder,
} from "../../core/runs/schema.js";
import { readProjectSkillSnapshot } from "../project-skill/project-skill-file.js";
import { resolveProject } from "../project-root/resolve-project.js";
import { finalizeRun } from "./finalize-run.js";
import { prepareRegressionWorkOrder } from "./start-regression-run.js";
import { VerdictService } from "./verdict-service.js";

type NotReadyPlatformReadiness = PlatformReadiness & { status: "not_ready" };

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
  readiness: NotReadyPlatformReadiness;
  now: () => Date;
  projectConfig?: ProjectConfig;
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
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  if (input.readiness.status !== "not_ready") {
    throw new AiQaError(
      "preflight.readiness_mismatch",
      "Preflight requires a not-ready doctor result",
    );
  }
  const config = projectConfigSchema.parse(
    input.projectConfig ?? (await readProjectConfig(project.projectRoot)),
  );
  if (!configuredPlatforms(config).includes(input.readiness.platform)) {
    throw new AiQaError("platform.unconfigured", "Run platform is not configured", {
      platform: input.readiness.platform,
      configuredPlatforms: configuredPlatforms(config),
    });
  }

  let workOrder: WorkOrder;
  if (input.kind === "exploratory") {
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
    const projectSkill =
      config.recordingPolicy.mode === "project-skill"
        ? await readProjectSkillSnapshot(project.projectRoot)
        : undefined;
    workOrder = createExploratoryWorkOrder({
      platform: input.readiness.platform,
      projectId: config.project.id,
      runId: createId("run"),
      input: payload,
      evidencePolicy: {
        screenshots: config.evidencePolicy.screenshots,
        defaultSensitivity: config.evidencePolicy.defaultSensitivity,
      },
      recordingPolicy: config.recordingPolicy,
      ...(projectSkill === undefined ? {} : { projectSkill }),
      startedAt: input.now(),
      preflightResult: true,
    }) as WorkOrder;
  } else {
    workOrder = (
      await prepareRegressionWorkOrder({
        projectRoot: project.projectRoot,
        caseId: input.caseId,
        execution: input.execution,
        readiness: input.readiness,
        now: input.now,
        preflightResult: true,
        projectConfig: config,
      })
    ).workOrder;
  }
  const runId = workOrder.runId;
  const repository = new RunRepository(project.projectRoot, input.now);
  const { journal } = await repository.create(workOrder);
  const started = (await journal.readAll())[0];
  if (started === undefined) {
    throw new AiQaError(
      "run_protocol.integrity_error",
      "Preflight run is missing its start anchor",
      { runId },
    );
  }
  const verdicts = new VerdictService(project.projectRoot, runId, input.now);
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
      summary: "Preflight checks prevented QA execution",
      criterionResults: [],
    });
    await finalizeRun({
      projectRoot: project.projectRoot,
      runId,
      now: input.now,
    });
    return { runId, status: "completed", verdict: "blocked", blockerSubtype };
  }

  await verdicts.set({
    classification: "not_verified",
    reasonCode: "incomplete_coverage",
    summary: "Agent confirmation is required before QA can execute",
    criterionResults: [],
  });
  await finalizeRun({
    projectRoot: project.projectRoot,
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
  checks: readonly PlatformReadiness["checks"][number][],
): "tool" | "environment" {
  return checks.some((check) => check.category === "tool")
    ? "tool"
    : "environment";
}
