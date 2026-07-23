import { canonicalJson, sha256Canonical } from "../../core/canonical-json.js";
import { readProjectConfig } from "../../core/config/repository.js";
import {
  configuredPlatforms,
  projectConfigSchema,
  type ProjectConfig,
} from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import { createId } from "../../core/ids.js";
import { RunRepository } from "../../core/runs/repository.js";
import { completedRunPayloadSchema } from "../../core/runs/lifecycle.js";
import type { PlatformReadiness } from "../../core/readiness/schema.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  type AppendRunEvent,
  type ExploratoryRunInput,
  type WorkOrder,
} from "../../core/runs/schema.js";
import {
  blockerPayloadSchema,
  verdictPayloadSchema,
} from "../../core/verdicts/schema.js";
import { readProjectSkillSnapshot } from "../project-skill/project-skill-file.js";
import { resolveProject } from "../project-root/resolve-project.js";
import { prepareRegressionWorkOrder } from "./start-regression-run.js";
import { validateRunSnapshot } from "./run-session.js";

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

export interface CreatePreflightResultRunOptions {
  beforePublish?: () => void;
}

export async function createPreflightResultRun(
  input: PreflightResultRunInput,
  options: CreatePreflightResultRunOptions = {},
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
    throw new AiQaError(
      "platform.unconfigured",
      "Run platform is not configured",
      {
        platform: input.readiness.platform,
        configuredPlatforms: configuredPlatforms(config),
      },
    );
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
        platform: input.readiness.platform,
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
  const failedChecks = input.readiness.checks.filter(
    (check) => check.status === "fail",
  );
  let result: PreflightResult | undefined;
  await repository.create(workOrder, {
    ...(options.beforePublish === undefined
      ? {}
      : { preCommit: options.beforePublish }),
    prepareJournal: (journal) => {
      let verdictId: string;
      if (failedChecks.length > 0) {
        const blockerSubtype = classifyFailedChecks(failedChecks);
        const blockerPayload = blockerPayloadSchema.parse({
          subtype: blockerSubtype,
          condition: failedChecks
            .map((check) => `${check.code}: ${check.message}`)
            .join("; "),
          attemptEventIds: [journal.started.id],
          criterionIds: [],
        });
        const blocker = journal.append({
          type: "blocker",
          actor: "agent",
          platform: workOrder.platform,
          tool: "ai-qa",
          idempotencyKey: `blocker:${sha256Canonical(blockerPayload)}`,
          payload: blockerPayload,
          relatedIds: [journal.started.id],
        });
        const verdictPayload = verdictPayloadSchema.parse({
          classification: "blocked",
          blockerSubtype,
          blockerIds: [blocker.id],
          summary: "Preflight checks prevented QA execution",
          criterionResults: [],
        });
        const verdict = journal.append(
          verdictAppendInput(workOrder, verdictPayload),
        );
        verdictId = verdict.id;
        result = {
          runId,
          status: "completed",
          verdict: "blocked",
          blockerSubtype,
        };
      } else {
        const verdictPayload = verdictPayloadSchema.parse({
          classification: "not_verified",
          reasonCode: "incomplete_coverage",
          summary: "Agent confirmation is required before QA can execute",
          criterionResults: [],
        });
        const verdict = journal.append(
          verdictAppendInput(workOrder, verdictPayload),
        );
        verdictId = verdict.id;
        result = {
          runId,
          status: "completed",
          verdict: "not_verified",
          reasonCode: "incomplete_coverage",
        };
      }
      const completed = completedRunPayloadSchema.parse({
        phase: "completed",
        verdictId,
      });
      journal.append({
        type: "run",
        actor: "ai-qa",
        platform: workOrder.platform,
        tool: "ai-qa",
        idempotencyKey: `finish:${runId}`,
        payload: completed,
        relatedIds: [verdictId],
      });
    },
    validateJournal: (events) => {
      validateRunSnapshot({
        workOrder,
        events,
      });
    },
  });
  if (result === undefined) {
    throw new AiQaError(
      "run_protocol.integrity_error",
      "Preflight result staging did not construct a terminal run",
      { runId },
    );
  }
  return result;
}

function verdictAppendInput(
  workOrder: WorkOrder,
  payload: ReturnType<typeof verdictPayloadSchema.parse>,
): AppendRunEvent {
  return {
    type: "verdict",
    actor: "agent",
    platform: workOrder.platform,
    tool: "ai-qa",
    idempotencyKey: `verdict:${sha256Canonical(payload)}`,
    payload,
    relatedIds:
      payload.classification === "blocked" ? [...payload.blockerIds] : [],
  };
}

function classifyFailedChecks(
  checks: readonly PlatformReadiness["checks"][number][],
): "tool" | "environment" {
  return checks.some((check) => check.category === "tool")
    ? "tool"
    : "environment";
}
