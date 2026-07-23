import { AiQaError } from "../../core/errors.js";
import { EvidenceRepository } from "../../core/evidence/repository.js";
import { validateEvidenceParity } from "../../core/evidence/parity.js";
import type { EvidenceRecord } from "../../core/evidence/schema.js";
import { assertJsonValue } from "../../core/json-value.js";
import { completedRunPayloadSchema } from "../../core/runs/lifecycle.js";
import {
  actionPayloadSchema,
  assertionPayloadSchema,
  evidenceEventPayloadSchema,
  recoveryPayloadSchema,
  type AssertionPayload,
} from "../../core/runs/event-payloads.js";
import {
  runIdSchema,
  type AppendRunEvent,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import {
  blockerPayloadSchema,
  type CriterionResult,
  type VerdictPayload,
} from "../../core/verdicts/schema.js";
import { validatePassEvidenceFreshness } from "./evidence-semantics.js";
import { validatePinnedRegressionCase } from "./pinned-case.js";
import { validateRegressionFidelity } from "./regression-fidelity.js";
import {
  sessionCommandState,
  withRunSession,
  type RunSession,
  type SessionCommandState,
} from "./run-session.js";
import type { VerdictEntry } from "./verdict-service.js";

export interface FinalizeRunResult extends SessionCommandState {
  readonly runId: string;
  readonly status: "completed";
  readonly verdict: "pass" | "fail" | "blocked" | "not_verified";
  readonly completedAt: string;
}

export async function finalizeRun(input: {
  projectRoot: string;
  runId: string;
  now: () => Date;
}): Promise<FinalizeRunResult> {
  const runId = runIdSchema.parse(input.runId);
  let commandTime: Date | undefined;
  let verifiedEvidence: readonly EvidenceRecord[] | undefined;
  const now = (): Date => (commandTime ??= input.now());
  return withRunSession(
    {
      projectRoot: input.projectRoot,
      runId,
      now,
      beforeValidate: async ({ events, workOrder }) => {
        verifiedEvidence = await new EvidenceRepository(
          input.projectRoot,
          runId,
          now,
          workOrder.platform,
        ).verifyAll();
        validateEvidenceParity(events, verifiedEvidence, runId);
      },
    },
    async (session) => {
      const { events, lifecycle, workOrder } = session.snapshot;
      const evidence = verifiedEvidence;
      if (evidence === undefined) {
        throw new Error("finalization evidence was not verified");
      }
      if (lifecycle.current.payload.phase === "cancelled") {
        throw new AiQaError(
          "run.cancelled",
          "Cancelled runs cannot be finalized",
          { runId },
        );
      }
      if (lifecycle.current.payload.phase === "interrupted") {
        throw new AiQaError(
          "run.interrupted",
          "Interrupted runs must be resumed before normal finalization",
          { runId },
        );
      }
      if (lifecycle.current.payload.phase === "completed") {
        const effective = lifecycle.effectiveVerdict;
        if (
          effective === undefined ||
          lifecycle.current.payload.verdictId !== effective.event.id
        ) {
          throw new AiQaError(
            "run.completion_conflict",
            "Completed run does not match the effective verdict",
            { runId },
          );
        }
        validateFinalization({
          workOrder,
          events,
          evidence,
          verdict: effective,
          completionTime: new Date(lifecycle.current.event.timestamp),
        });
        return completionResult(
          session,
          runId,
          effective.payload,
          lifecycle.current.event.timestamp,
        );
      }

      if (workOrder.kind === "regression") {
        await validatePinnedRegressionCase(input.projectRoot, workOrder);
      }

      const effective = lifecycle.effectiveVerdict;
      if (effective === undefined) {
        throw new AiQaError(
          "verdict.missing",
          "A run requires one effective verdict before completion",
          { runId },
        );
      }
      const completionInput = completionAppendInput(
        workOrder.platform,
        runId,
        effective.event.id,
      );
      const completionTime = now();
      validateFinalization({
        workOrder,
        events,
        evidence,
        verdict: effective,
        completionTime,
      });
      const event = (await session.append([completionInput]))[0];
      if (event === undefined) {
        throw new Error("completion append returned no event");
      }
      return completionResult(
        session,
        runId,
        effective.payload,
        event.timestamp,
      );
    },
  );
}

export function validateFinalization(input: {
  workOrder: WorkOrder;
  events: readonly RunEvent[];
  evidence: readonly EvidenceRecord[];
  verdict: VerdictEntry;
  completionTime: Date;
}): void {
  if (
    input.workOrder.kind === "regression" &&
    input.workOrder.preflightResult !== true
  ) {
    const fidelity = validateRegressionFidelity(input.workOrder, [
      ...input.events,
    ]);
    if (input.verdict.payload.classification === "pass" && !fidelity.valid) {
      throw new AiQaError(
        "replay.fidelity_incomplete",
        "Regression replay does not satisfy the pinned required-step protocol",
        { ...fidelity },
      );
    }
  }
  const plans = input.events.flatMap((event) => {
    if (event.type !== "action") return [];
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase === "planned" ? [{ event, payload }] : [];
  });
  const terminals = input.events.flatMap((event) => {
    if (event.type !== "action") return [];
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase === "planned" ? [] : [{ event, payload }];
  });
  if (plans.length === 0 && input.workOrder.preflightResult !== true) {
    throw new AiQaError(
      "run.action_required",
      "Executable runs require at least one recorded platform action",
    );
  }
  for (const plan of plans) {
    const matching = terminals.filter(
      ({ payload }) => payload.actionId === plan.event.id,
    );
    if (matching.length !== 1) {
      throw new AiQaError(
        "run.action_incomplete",
        "Every planned action requires exactly one terminal result",
        { actionId: plan.event.id },
      );
    }
  }

  const recoveryByAction = new Map<
    string,
    { payload: ReturnType<typeof recoveryPayloadSchema.parse> }
  >();
  for (const event of input.events) {
    if (event.type !== "recovery") continue;
    const payload = recoveryPayloadSchema.parse(event.payload);
    recoveryByAction.set(payload.actionId, { payload });
  }
  for (const terminal of terminals) {
    if (terminal.payload.phase !== "unknown") continue;
    const recovery = recoveryByAction.get(terminal.payload.actionId);
    if (recovery === undefined) {
      throw new AiQaError(
        "run.unknown_unresolved",
        "Every unknown action requires an explicit recovery resolution",
        { actionId: terminal.payload.actionId },
      );
    }
    if (
      recovery.payload.resolution === "indeterminate" &&
      input.verdict.payload.classification === "pass"
    ) {
      throw unsupportedPass("An indeterminate action prevents pass");
    }
  }

  const recoveryCount = plans.filter(
    ({ payload }) => payload.recoveryForStepId !== undefined,
  ).length;
  if (
    plans.length > input.workOrder.budget.maxToolCalls ||
    recoveryCount > input.workOrder.budget.maxRecoveryActions
  ) {
    throw new AiQaError(
      "run.budget_exceeded",
      "Run history exceeds the frozen execution budget",
    );
  }

  const assertions = assertionMap(input.events);
  const evidenceById = new Map(
    input.evidence.map((record) => [record.id, record]),
  );
  const evidenceEvents = evidenceEventMap(input.events);
  validateVerdictCitations(
    input.verdict.payload,
    assertions,
    evidenceById,
    evidenceEvents,
  );
  validatePassEvidenceFreshness(input.events, input.verdict.payload);
  switch (input.verdict.payload.classification) {
    case "pass":
      validatePass(
        input.workOrder,
        input.verdict.payload.criterionResults,
        assertions,
        evidenceById,
      );
      break;
    case "fail":
      validateFail(input.verdict.payload.criterionResults);
      break;
    case "blocked":
      validateBlocked(input.events, input.verdict.payload);
      break;
    case "not_verified":
      validateNotVerified({
        workOrder: input.workOrder,
        events: input.events,
        verdict: input.verdict.payload,
        completionTime: input.completionTime,
      });
      break;
  }
  validateScreenshotPolicy(
    input.workOrder,
    input.verdict.payload.criterionResults,
    evidenceById,
  );
  if (
    input.verdict.payload.classification === "pass" &&
    input.completionTime.getTime() >
      new Date(input.workOrder.budget.deadline).getTime()
  ) {
    throw new AiQaError(
      "run.deadline_exceeded",
      "A pass verdict cannot complete after the frozen deadline",
      {
        runId: input.workOrder.runId,
        deadline: input.workOrder.budget.deadline,
      },
    );
  }
}

function validateVerdictCitations(
  verdict: VerdictPayload,
  assertions: ReadonlyMap<string, AssertionPayload>,
  evidence: ReadonlyMap<string, EvidenceRecord>,
  evidenceEvents: ReadonlyMap<
    string,
    ReturnType<typeof evidenceEventPayloadSchema.parse>
  >,
): void {
  for (const result of verdict.criterionResults) {
    for (const assertionId of result.assertionIds) {
      const assertion = assertions.get(assertionId);
      if (
        assertion === undefined ||
        assertion.criterionId !== result.criterionId ||
        assertion.status !== result.status
      ) {
        throw invalidVerdictCitation("assertion", assertionId);
      }
    }
    for (const evidenceId of result.evidenceIds) {
      if (
        !evidence.has(evidenceId) ||
        !evidenceEvents
          .get(evidenceId)
          ?.criterionIds.includes(result.criterionId)
      ) {
        throw invalidVerdictCitation("evidence", evidenceId);
      }
    }
  }
}

function validatePass(
  workOrder: WorkOrder,
  results: readonly CriterionResult[],
  assertions: ReadonlyMap<string, AssertionPayload>,
  evidence: ReadonlyMap<string, EvidenceRecord>,
): void {
  for (const criterion of workOrder.acceptanceCriteria) {
    const result = results.find((entry) => entry.criterionId === criterion.id);
    if (result?.status !== "satisfied" || result.assertionIds.length === 0) {
      throw unsupportedPass(`Criterion ${criterion.id} is not supported`);
    }
    const represented = new Set([
      ...result.assertionIds.flatMap(
        (id) => assertions.get(id)?.assertionKinds ?? [],
      ),
      ...result.evidenceIds.flatMap(
        (id) => evidence.get(id)?.evidenceKinds ?? [],
      ),
    ]);
    if (!criterion.requiredEvidence.every((kind) => represented.has(kind))) {
      throw unsupportedPass(
        `Criterion ${criterion.id} lacks required evidence kinds`,
      );
    }
  }
  if (results.length !== workOrder.acceptanceCriteria.length) {
    throw unsupportedPass(
      "Pass must cover every work-order criterion exactly once",
    );
  }
}

function validateFail(results: readonly CriterionResult[]): void {
  if (
    !results.some(
      (result) =>
        result.status === "violated" &&
        result.assertionIds.length > 0 &&
        result.evidenceIds.length > 0,
    )
  ) {
    throw new AiQaError(
      "verdict.unsupported_fail",
      "Fail requires a violated criterion backed by assertion and evidence",
    );
  }
}

function validateBlocked(
  events: readonly RunEvent[],
  verdict: Extract<VerdictPayload, { classification: "blocked" }>,
): void {
  const blockers = verdict.blockerIds.map((id) => {
    const event = events.find(
      (candidate) => candidate.id === id && candidate.type === "blocker",
    );
    if (event === undefined) throw invalidVerdictCitation("blocker", id);
    return {
      event,
      payload: blockerPayloadSchema.parse(event.payload),
    };
  });
  if (
    blockers.some(({ payload }) => payload.subtype !== verdict.blockerSubtype)
  ) {
    throw new AiQaError(
      "verdict.blocker_subtype_mismatch",
      "Blocked verdict must cite blockers of the declared subtype",
    );
  }
  if (
    verdict.blockerSubtype === "evidence" &&
    !blockers.some(({ payload }) =>
      payload.attemptEventIds.some((id) => isEvidenceAttempt(events, id)),
    )
  ) {
    throw new AiQaError(
      "verdict.evidence_attempt_required",
      "blocked:evidence requires a concrete evidence attempt event",
    );
  }
}

function validateNotVerified(input: {
  workOrder: WorkOrder;
  events: readonly RunEvent[];
  verdict: Extract<VerdictPayload, { classification: "not_verified" }>;
  completionTime: Date;
}): void {
  const covered = new Map(
    input.verdict.criterionResults.map((result) => [
      result.criterionId,
      result,
    ]),
  );
  const incomplete = input.workOrder.acceptanceCriteria.some(
    (criterion) =>
      covered.get(criterion.id) === undefined ||
      covered.get(criterion.id)?.status === "indeterminate",
  );
  const plans = input.events.filter(
    (event) =>
      event.type === "action" &&
      actionPayloadSchema.safeParse(event.payload).data?.phase === "planned",
  );
  const recoveryPlans = plans.filter((event) => {
    const payload = actionPayloadSchema.parse(event.payload);
    return (
      payload.phase === "planned" && payload.recoveryForStepId !== undefined
    );
  });
  const indeterminateUnknown = input.events.some(
    (event) =>
      event.type === "recovery" &&
      recoveryPayloadSchema.safeParse(event.payload).data?.resolution ===
        "indeterminate",
  );
  const reasonMatches =
    (input.verdict.reasonCode === "incomplete_coverage" && incomplete) ||
    (input.verdict.reasonCode === "unknown_action" && indeterminateUnknown) ||
    (input.verdict.reasonCode === "budget_exhausted" &&
      (plans.length >= input.workOrder.budget.maxToolCalls ||
        recoveryPlans.length >= input.workOrder.budget.maxRecoveryActions ||
        input.completionTime.getTime() >=
          new Date(input.workOrder.budget.deadline).getTime()));
  if (!reasonMatches) {
    throw new AiQaError(
      "verdict.unsupported_not_verified",
      "not_verified reason must match incomplete coverage or run history",
    );
  }
  if (input.verdict.reasonCode === "cancelled") {
    throw new AiQaError(
      "verdict.cancel_requires_lifecycle",
      "Cancelled verdicts use the explicit cancel lifecycle",
    );
  }
}

function validateScreenshotPolicy(
  workOrder: WorkOrder,
  results: readonly CriterionResult[],
  evidence: ReadonlyMap<string, EvidenceRecord>,
): void {
  if (workOrder.evidencePolicy.screenshots === "optional") return;
  for (const result of results) {
    const required =
      workOrder.evidencePolicy.screenshots === "required"
        ? result.status === "satisfied" || result.status === "violated"
        : result.status === "violated";
    if (
      required &&
      !result.evidenceIds.some((id) =>
        evidence.get(id)?.evidenceKinds.includes("post-action-screenshot"),
      )
    ) {
      throw new AiQaError(
        "verdict.screenshot_required",
        "The frozen evidence policy requires a cited post-action screenshot",
        { criterionId: result.criterionId },
      );
    }
  }
}

function assertionMap(
  events: readonly RunEvent[],
): Map<string, AssertionPayload> {
  const assertions = new Map<string, AssertionPayload>();
  for (const event of events) {
    if (event.type === "assertion") {
      assertions.set(event.id, assertionPayloadSchema.parse(event.payload));
    }
  }
  return assertions;
}

function evidenceEventMap(
  events: readonly RunEvent[],
): Map<string, ReturnType<typeof evidenceEventPayloadSchema.parse>> {
  const evidence = new Map<
    string,
    ReturnType<typeof evidenceEventPayloadSchema.parse>
  >();
  for (const event of events) {
    if (event.type !== "evidence") continue;
    const payload = evidenceEventPayloadSchema.parse(event.payload);
    evidence.set(payload.id, payload);
  }
  return evidence;
}

function isEvidenceAttempt(events: readonly RunEvent[], id: string): boolean {
  const event = events.find((candidate) => candidate.id === id);
  if (event?.type === "evidence") return true;
  if (event?.type !== "action") return false;
  const payload = actionPayloadSchema.safeParse(event.payload);
  if (!payload.success) return false;
  if (payload.data.phase === "planned") {
    return payload.data.kind === "evidence-capture";
  }
  const actionId = payload.data.actionId;
  const plan = events.find((candidate) => candidate.id === actionId);
  const planPayload = actionPayloadSchema.safeParse(plan?.payload);
  return (
    planPayload.success &&
    planPayload.data.phase === "planned" &&
    planPayload.data.kind === "evidence-capture"
  );
}

function completionAppendInput(
  platform: WorkOrder["platform"],
  runId: string,
  verdictId: string,
): AppendRunEvent {
  const payload = completedRunPayloadSchema.parse({
    phase: "completed",
    verdictId,
  });
  assertJsonValue(payload);
  return {
    type: "run",
    actor: "ai-qa",
    platform,
    tool: "ai-qa",
    idempotencyKey: `finish:${runId}`,
    payload,
    relatedIds: [verdictId],
  };
}

function completionResult(
  session: RunSession,
  runId: string,
  verdict: VerdictPayload,
  completedAt: string,
): FinalizeRunResult {
  return {
    runId,
    status: "completed",
    verdict: verdict.classification,
    completedAt,
    ...sessionCommandState(session),
  };
}

function unsupportedPass(message: string): AiQaError {
  return new AiQaError("verdict.unsupported_pass", message);
}

function invalidVerdictCitation(kind: string, id: string): AiQaError {
  return new AiQaError(
    "verdict.citation_invalid",
    "Verdict citations must resolve to matching typed run records",
    { kind, id },
  );
}
