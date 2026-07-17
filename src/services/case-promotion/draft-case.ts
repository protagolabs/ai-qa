import { z } from "zod";
import { canonicalJson } from "../../core/canonical-json.js";
import { CaseRepository } from "../../core/cases/repository.js";
import {
  caseIdSchema,
  caseValidationIssueSchema,
  type CaseStep,
  type CaseRevision,
  type CaseValidationIssue,
} from "../../core/cases/schema.js";
import { AiQaError } from "../../core/errors.js";
import { validateEvidenceParity } from "../../core/evidence/parity.js";
import { EvidenceRepository } from "../../core/evidence/repository.js";
import type { EvidenceRecord } from "../../core/evidence/schema.js";
import {
  actionPayloadSchema,
  assertionPayloadSchema,
  evidenceEventPayloadSchema,
  observationPayloadSchema,
  recoveryPayloadSchema,
} from "../../core/runs/event-payloads.js";
import { validateRunLifecycleHistory } from "../../core/runs/lifecycle.js";
import { RunRepository } from "../../core/runs/repository.js";
import type { RunEvent, WorkOrder } from "../../core/runs/schema.js";
import { controllerForPlatform } from "../../core/platforms/registry.js";
import { platformSchema } from "../../core/platforms/schema.js";
import type { VerdictPayload } from "../../core/verdicts/schema.js";
import { effectiveInteractionSuccesses } from "../run-protocol/effective-interactions.js";
import { validateFinalization } from "../run-protocol/finalize-run.js";
import { validateProtocolEvents } from "../run-protocol/run-protocol-service.js";
import {
  effectiveVerdictFrom,
  validateVerdictHistory,
} from "../run-protocol/verdict-service.js";

const draftCaseStepSchema = z
  .object({
    sourceActionId: z.string().min(1),
    intent: z.string().trim().min(1),
    target: z
      .object({
        description: z.string().trim().min(1),
        selector: z.string().trim().min(1).optional(),
        stability: z.enum(["stable", "review-required"]),
        stabilityRationale: z.string().trim().min(1),
      })
      .strict(),
    expectedState: z.string().trim().min(1),
    assertionStrategy: z.string().trim().min(1),
    evidenceCheckpoints: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export const draftCaseInputSchema = z
  .object({
    caseId: caseIdSchema,
    title: z.string().trim().min(1),
    steps: z.array(draftCaseStepSchema).min(1),
    excludedActions: z.array(
      z.object({ actionId: z.string().min(1), reason: z.string() }).strict(),
    ),
  })
  .strict();

export interface DraftCaseInput {
  caseId: string;
  title: string;
  steps: Array<{
    sourceActionId: string;
    intent: string;
    target: {
      description: string;
      selector?: string;
      stability: "stable" | "review-required";
      stabilityRationale: string;
    };
    expectedState: string;
    assertionStrategy: string;
    evidenceCheckpoints: string[];
  }>;
  excludedActions: Array<{ actionId: string; reason: string }>;
}

export interface CaseValidationResult {
  revision: CaseRevision;
  valid: boolean;
  issues: Array<{ code: string; message: string; relatedIds: string[] }>;
}

interface SourceRunSnapshot {
  workOrder: WorkOrder;
  events: readonly RunEvent[];
  verdict: VerdictPayload;
  evidence: readonly EvidenceRecord[];
  evidenceValid: boolean;
}

interface ProposedStep {
  sourceActionId: string;
  target: {
    stability: "stable" | "review-required";
    stabilityRationale: string;
  };
  evidenceCheckpoints: string[];
}

export async function draftCaseFromRun(input: {
  projectRoot: string;
  runId: string;
  input: DraftCaseInput;
}): Promise<CaseRevision> {
  const supplied = draftCaseInputSchema.parse(input.input);
  const source = await readCompletedExploratoryRun(
    input.projectRoot,
    input.runId,
  );
  const issues = analyzePromotion({
    source,
    steps: supplied.steps,
    excludedActions: supplied.excludedActions,
    requireInteractionAccounting: true,
  });
  const platform = source.workOrder.platform;
  const steps: CaseStep[] = supplied.steps.map((step, index) => ({
    id: stableStepId(index + 1, step.intent),
    sourceActionId: step.sourceActionId,
    intent: step.intent,
    tool: controllerForPlatform(platform),
    target: step.target,
    expectedState: step.expectedState,
    assertionStrategy: step.assertionStrategy,
    evidenceCheckpoints: step.evidenceCheckpoints,
  }));
  const repository = new CaseRepository(input.projectRoot, () => new Date());
  return repository.createDraftFromLatest(
    supplied.caseId,
    supplied.title,
    (latest) => {
      const variants: CaseRevision["variants"] = {
        ...(latest?.variants ?? {}),
      };
      variants[platform] = { steps };
      const sources: CaseRevision["promotion"]["sources"] = {
        ...(latest?.promotion.sources ?? {}),
      };
      sources[platform] = {
        sourceRunId: input.runId,
        excludedActions: supplied.excludedActions,
      };
      const sharedIssues = latestSharedFieldIssues(
        latest,
        supplied.title,
        source,
      );
      return {
        schemaVersion: 1,
        caseId: supplied.caseId,
        title: latest?.title ?? supplied.title,
        promotion: {
          sources,
          validationIssues: deduplicateIssues([...issues, ...sharedIssues]),
        },
        acceptanceCriteria:
          latest?.acceptanceCriteria ?? source.workOrder.acceptanceCriteria,
        variants,
      };
    },
  );
}

export async function validateCaseRevision(input: {
  projectRoot: string;
  caseId: string;
  revision: number;
}): Promise<CaseValidationResult> {
  const repository = new CaseRepository(input.projectRoot, () => new Date());
  const revision = await repository.validateRevision(
    input.caseId,
    input.revision,
  );
  const sourceIssues: CaseValidationIssue[] = [];
  for (const platform of platformSchema.options) {
    const promotionSource = revision.promotion.sources[platform];
    const variant = revision.variants[platform];
    if (promotionSource === undefined || variant === undefined) continue;
    const source = await readCompletedExploratoryRun(
      input.projectRoot,
      promotionSource.sourceRunId,
    );
    if (source.workOrder.platform !== platform) {
      sourceIssues.push(
        issue(
          "case.source_platform_mismatch",
          "Each promotion source must match its stored platform variant",
          [promotionSource.sourceRunId, platform],
        ),
      );
      continue;
    }
    sourceIssues.push(
      ...analyzePromotion({
        source,
        steps: variant.steps,
        excludedActions: promotionSource.excludedActions ?? [],
        requireInteractionAccounting: true,
      }),
    );
    if (
      canonicalJson(revision.acceptanceCriteria) !==
      canonicalJson(source.workOrder.acceptanceCriteria)
    ) {
      sourceIssues.push(acceptanceCriteriaMismatchIssue(source));
    }
  }
  const issues = deduplicateIssues([
    ...revision.promotion.validationIssues,
    ...sourceIssues,
  ]);
  return { revision, valid: issues.length === 0, issues };
}

function latestSharedFieldIssues(
  latest: CaseRevision | undefined,
  suppliedTitle: string,
  source: SourceRunSnapshot,
): CaseValidationIssue[] {
  if (latest === undefined) return [];
  const issues: CaseValidationIssue[] = [];
  if (latest.title !== suppliedTitle) {
    issues.push(
      issue(
        "case.title_mismatch",
        "Case title must match the latest immutable revision",
        [latest.caseId],
      ),
    );
  }
  if (
    canonicalJson(latest.acceptanceCriteria) !==
    canonicalJson(source.workOrder.acceptanceCriteria)
  ) {
    issues.push(acceptanceCriteriaMismatchIssue(source));
  }
  return issues;
}

function acceptanceCriteriaMismatchIssue(
  source: SourceRunSnapshot,
): CaseValidationIssue {
  return issue(
    "case.acceptance_criteria_mismatch",
    "Case criteria must match every immutable platform source work order",
    source.workOrder.acceptanceCriteria.map((criterion) => criterion.id),
  );
}

export async function activateCaseRevision(input: {
  projectRoot: string;
  caseId: string;
  revision: number;
  reviewConfirmed: boolean;
  now: () => Date;
}): Promise<CaseRevision> {
  if (input.reviewConfirmed !== true) {
    throw new AiQaError(
      "case.review_confirmation_required",
      "Case activation requires explicit user review confirmation",
      { caseId: input.caseId, revision: input.revision },
    );
  }
  const validation = await validateCaseRevision(input);
  if (!validation.valid) {
    throw new AiQaError(
      "case.activation_validation_failed",
      "Only a fully valid evidence-backed case revision can be activated",
      {
        caseId: input.caseId,
        revision: input.revision,
        issues: validation.issues,
      },
    );
  }
  const confirmedAt = input.now().toISOString();
  return new CaseRepository(input.projectRoot, input.now).activate(
    input.caseId,
    input.revision,
    { confirmedBy: "user", confirmedAt },
  );
}

async function readCompletedExploratoryRun(
  projectRoot: string,
  runId: string,
): Promise<SourceRunSnapshot> {
  const now = () => new Date(0);
  const repository = new RunRepository(projectRoot, now);
  return repository.journal(runId).readLocked(async (events) => {
    const workOrder = await repository.readVerifiedWorkOrder(runId);
    if (workOrder.kind !== "exploratory") {
      throw new AiQaError(
        "case.source_run_not_exploratory",
        "Only exploratory runs can be promoted into cases",
        { runId },
      );
    }
    const evidenceResult = await readVerifiedEvidence(
      projectRoot,
      runId,
      events,
      now,
      workOrder.platform,
    );
    validateProtocolEvents(events, workOrder, runId, {
      evidenceParityAuthoritative: !evidenceResult.valid,
    });
    const lifecycle = validateRunLifecycleHistory(events, runId);
    if (lifecycle.current.payload.phase !== "completed") {
      throw new AiQaError(
        "case.source_run_incomplete",
        "Only completed exploratory runs can be promoted",
        { runId },
      );
    }
    const effective = effectiveVerdictFrom(
      validateVerdictHistory(events, workOrder),
    );
    if (
      effective === undefined ||
      lifecycle.current.payload.verdictId !== effective.event.id
    ) {
      throw new AiQaError(
        "case.source_run_integrity_error",
        "Completed source run does not match its effective verdict",
        { runId },
      );
    }
    let evidenceValid = evidenceResult.valid;
    if (evidenceValid) {
      try {
        validateFinalization({
          workOrder,
          events,
          evidence: evidenceResult.evidence,
          verdict: effective,
          completionTime: new Date(lifecycle.current.event.timestamp),
        });
      } catch (error: unknown) {
        if (!(error instanceof AiQaError)) throw error;
        evidenceValid = false;
      }
    }
    return {
      workOrder,
      events,
      verdict: effective.payload,
      evidence: evidenceResult.evidence,
      evidenceValid,
    };
  });
}

async function readVerifiedEvidence(
  projectRoot: string,
  runId: string,
  events: readonly RunEvent[],
  now: () => Date,
  platform: WorkOrder["platform"],
): Promise<{ evidence: EvidenceRecord[]; valid: boolean }> {
  try {
    const evidence = await new EvidenceRepository(
      projectRoot,
      runId,
      now,
      platform,
    ).verifyAll();
    validateEvidenceParity(events, evidence, runId);
    return { evidence, valid: true };
  } catch {
    return { evidence: [], valid: false };
  }
}

function analyzePromotion(input: {
  source: SourceRunSnapshot;
  steps: readonly ProposedStep[];
  excludedActions: readonly { actionId: string; reason: string }[];
  requireInteractionAccounting: boolean;
}): CaseValidationIssue[] {
  const issues: CaseValidationIssue[] = [];
  if (input.source.verdict.classification !== "pass") {
    issues.push(
      issue(
        "case.source_verdict_not_pass",
        "Only a source run with an effective pass verdict can be activated",
        [input.source.workOrder.runId],
      ),
    );
  }
  if (!input.source.evidenceValid) {
    issues.push(
      issue(
        "case.evidence_invalid",
        "Source evidence failed immutable integrity verification",
        [input.source.workOrder.runId],
      ),
    );
  }
  issues.push(...sourceCriterionCoverageIssues(input.source));

  const planned = input.source.events.flatMap((event) => {
    if (event.type !== "action") return [];
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase === "planned" ? [{ event, payload }] : [];
  });
  const terminals = input.source.events.flatMap((event) => {
    if (event.type !== "action") return [];
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase === "planned" ? [] : [{ event, payload }];
  });
  const recoveries = input.source.events.flatMap((event) => {
    if (event.type !== "recovery") return [];
    return [{ event, payload: recoveryPayloadSchema.parse(event.payload) }];
  });

  for (const plan of planned) {
    const matching = terminals.filter(
      ({ payload }) => payload.actionId === plan.event.id,
    );
    if (matching.length !== 1) {
      issues.push(
        issue(
          "case.action_write_back_missing",
          "Every planned source action requires exactly one terminal write-back",
          [plan.event.id],
        ),
      );
      continue;
    }
    const terminal = matching[0]!;
    if (terminal.payload.phase !== "unknown") continue;
    const resolutions = recoveries.filter(
      ({ payload }) => payload.actionId === plan.event.id,
    );
    if (
      resolutions.length !== 1 ||
      resolutions[0]?.payload.resolution === "indeterminate"
    ) {
      issues.push(
        issue(
          "case.unknown_action_unresolved",
          "Unknown or indeterminate source actions cannot be activated",
          [plan.event.id],
        ),
      );
    }
  }

  const interactions = planned.filter(
    ({ payload }) =>
      payload.kind === "interaction" && payload.recoveryForStepId === undefined,
  );
  const interactionIds = new Set(interactions.map(({ event }) => event.id));
  const proposedCounts = countIds(
    input.steps.map((step) => step.sourceActionId),
  );
  const excludedCounts = countIds(
    input.excludedActions.map((entry) => entry.actionId),
  );

  for (const [actionId, count] of proposedCounts) {
    if (!interactionIds.has(actionId) || count !== 1) {
      issues.push(
        issue(
          "case.source_action_invalid",
          "Each proposed step must cite one unique non-recovery interaction",
          [actionId],
        ),
      );
    }
  }
  for (const excluded of input.excludedActions) {
    if (
      !interactionIds.has(excluded.actionId) ||
      excludedCounts.get(excluded.actionId) !== 1
    ) {
      issues.push(
        issue(
          "case.excluded_action_invalid",
          "Each excluded action must cite one unique non-recovery interaction",
          [excluded.actionId],
        ),
      );
    }
    if (excluded.reason.trim().length === 0) {
      issues.push(
        issue(
          "case.excluded_action_reason_missing",
          "Excluded interactions require a non-empty review rationale",
          [excluded.actionId],
        ),
      );
    }
  }
  if (input.requireInteractionAccounting) {
    for (const { event } of interactions) {
      if (
        (proposedCounts.get(event.id) ?? 0) +
          (excludedCounts.get(event.id) ?? 0) !==
        1
      ) {
        issues.push(
          issue(
            "case.interaction_unmapped",
            "Every non-recovery interaction must be proposed or explicitly excluded exactly once",
            [event.id],
          ),
        );
      }
    }
  }

  const plannedById = new Map(planned.map((entry) => [entry.event.id, entry]));
  const proofKindsByStep = proofKindsForSteps(
    input.source.events,
    input.source.evidence,
    plannedById,
  );
  for (const step of input.steps) {
    if (
      step.target.stability !== "stable" ||
      step.target.stabilityRationale.trim().length === 0
    ) {
      issues.push(
        issue(
          "case.target_review_required",
          "Every activated target must be stable with a review rationale",
          [step.sourceActionId],
        ),
      );
    }
    const sourceStepId = plannedById.get(step.sourceActionId)?.payload.stepId;
    const available =
      sourceStepId === undefined
        ? new Set<string>()
        : (proofKindsByStep.get(sourceStepId) ?? new Set<string>());
    const missing = step.evidenceCheckpoints.filter(
      (checkpoint) => !available.has(checkpoint),
    );
    if (missing.length > 0) {
      issues.push(
        issue(
          "case.evidence_checkpoint_missing",
          "Every proposed evidence checkpoint must exist in source evidence for the step",
          [step.sourceActionId, ...missing],
        ),
      );
    }
  }

  const proposedCheckpoints = new Set(
    input.steps.flatMap((step) => step.evidenceCheckpoints),
  );
  for (const criterion of input.source.workOrder.acceptanceCriteria) {
    const missing = criterion.requiredEvidence.filter(
      (kind) => !proposedCheckpoints.has(kind),
    );
    if (missing.length > 0) {
      issues.push(
        issue(
          "case.criterion_coverage_missing",
          "Case steps must cover every required criterion evidence kind",
          [criterion.id, ...missing],
        ),
      );
    }
  }
  return deduplicateIssues(issues);
}

function sourceCriterionCoverageIssues(
  source: SourceRunSnapshot,
): CaseValidationIssue[] {
  const assertions = new Map(
    source.events.flatMap((event) =>
      event.type === "assertion"
        ? [[event.id, assertionPayloadSchema.parse(event.payload)] as const]
        : [],
    ),
  );
  const evidenceById = new Map(
    source.evidence.map((record) => [record.id, record]),
  );
  const evidenceEvents = new Map(
    source.events.flatMap((event) => {
      if (event.type !== "evidence") return [];
      const payload = evidenceEventPayloadSchema.parse(event.payload);
      return [[payload.id, payload] as const];
    }),
  );
  const results = source.verdict.criterionResults;
  return source.workOrder.acceptanceCriteria.flatMap((criterion) => {
    const result = results.find((entry) => entry.criterionId === criterion.id);
    if (result?.status !== "satisfied" || result.assertionIds.length === 0) {
      return [
        issue(
          "case.criterion_coverage_missing",
          "Source pass must cite a satisfied assertion for every criterion",
          [criterion.id],
        ),
      ];
    }
    const citedAssertions = result.assertionIds.map((id) => assertions.get(id));
    const assertionsValid = citedAssertions.every(
      (assertion) =>
        assertion !== undefined &&
        assertion.criterionId === criterion.id &&
        assertion.status === result.status,
    );
    const evidenceValid = result.evidenceIds.every((id) => {
      const record = evidenceById.get(id);
      const event = evidenceEvents.get(id);
      return (
        record !== undefined &&
        event?.criterionIds.includes(criterion.id) === true
      );
    });
    const represented = new Set([
      ...citedAssertions.flatMap((assertion) =>
        assertion === undefined ? [] : assertion.assertionKinds,
      ),
      ...result.evidenceIds.flatMap(
        (id) => evidenceById.get(id)?.evidenceKinds ?? [],
      ),
    ]);
    if (
      !assertionsValid ||
      !evidenceValid ||
      !criterion.requiredEvidence.every((kind) => represented.has(kind))
    ) {
      return [
        issue(
          "case.criterion_coverage_missing",
          "Source pass criterion citations must resolve and represent every required evidence kind",
          [criterion.id, ...result.assertionIds, ...result.evidenceIds],
        ),
      ];
    }
    return [];
  });
}

function proofKindsForSteps(
  events: readonly RunEvent[],
  evidence: readonly EvidenceRecord[],
  plannedById: ReadonlyMap<
    string,
    {
      event: RunEvent;
      payload: Extract<
        ReturnType<typeof actionPayloadSchema.parse>,
        { phase: "planned" }
      >;
    }
  >,
): Map<string, Set<string>> {
  const validEvidenceIds = new Set(evidence.map((record) => record.id));
  const result = new Map<string, Set<string>>();
  const completedByActionId = new Map(
    events.flatMap((event) => {
      if (event.type !== "action") return [];
      const payload = actionPayloadSchema.parse(event.payload);
      return payload.phase === "completed"
        ? [[payload.actionId, event] as const]
        : [];
    }),
  );
  const successfulInteractionByStep = new Map<string, RunEvent>();
  for (const success of effectiveInteractionSuccesses(events)) {
    if (success.planPayload.recoveryForStepId !== undefined) continue;
    const latest = successfulInteractionByStep.get(success.stepId);
    if (
      latest === undefined ||
      success.boundaryEvent.sequence > latest.sequence
    ) {
      successfulInteractionByStep.set(success.stepId, success.boundaryEvent);
    }
  }
  const observationsByStep = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== "observation") continue;
    const payload = observationPayloadSchema.parse(event.payload);
    if (payload.stepId === undefined) continue;
    const success = successfulInteractionByStep.get(payload.stepId);
    const plan = plannedById.get(payload.actionId);
    const terminal = completedByActionId.get(payload.actionId);
    if (
      success === undefined ||
      plan?.payload.kind !== "observation" ||
      plan.payload.stepId !== payload.stepId ||
      plan.event.sequence <= success.sequence ||
      terminal === undefined ||
      terminal.sequence <= success.sequence ||
      event.sequence <= success.sequence
    ) {
      continue;
    }
    const observations = observationsByStep.get(payload.stepId) ?? new Set();
    observations.add(event.id);
    observationsByStep.set(payload.stepId, observations);
  }
  const evidenceIdsByStep = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== "evidence") continue;
    const payload = evidenceEventPayloadSchema.parse(event.payload);
    if (!validEvidenceIds.has(payload.id)) continue;
    const capture = plannedById.get(payload.captureActionId);
    const stepId = capture?.payload.stepId;
    if (capture === undefined || stepId === undefined) continue;
    const success = successfulInteractionByStep.get(stepId);
    const terminal = completedByActionId.get(payload.captureActionId);
    const observations = observationsByStep.get(stepId);
    if (
      success === undefined ||
      capture.payload.kind !== "evidence-capture" ||
      capture.event.sequence <= success.sequence ||
      terminal === undefined ||
      terminal.sequence <= success.sequence ||
      event.sequence <= success.sequence ||
      !payload.observationIds.some((id) => observations?.has(id) === true)
    ) {
      continue;
    }
    addProofKinds(result, stepId, payload.evidenceKinds);
    const evidenceIds = evidenceIdsByStep.get(stepId) ?? new Set();
    evidenceIds.add(payload.id);
    evidenceIdsByStep.set(stepId, evidenceIds);
  }
  for (const event of events) {
    if (event.type !== "assertion") continue;
    const payload = assertionPayloadSchema.parse(event.payload);
    if (payload.stepId === undefined || payload.status !== "satisfied")
      continue;
    const success = successfulInteractionByStep.get(payload.stepId);
    if (
      success === undefined ||
      event.sequence <= success.sequence ||
      !payload.observationIds.some(
        (id) => observationsByStep.get(payload.stepId!)?.has(id) === true,
      ) ||
      !payload.evidenceIds.some(
        (id) => evidenceIdsByStep.get(payload.stepId!)?.has(id) === true,
      )
    ) {
      continue;
    }
    addProofKinds(result, payload.stepId, payload.assertionKinds);
  }
  return result;
}

function addProofKinds(
  result: Map<string, Set<string>>,
  stepId: string,
  proofKinds: readonly string[],
): void {
  const kinds = result.get(stepId) ?? new Set<string>();
  for (const kind of proofKinds) kinds.add(kind);
  result.set(stepId, kinds);
}

function countIds(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function stableStepId(order: number, intent: string): string {
  const slug = intent
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `step-${String(order)}-${slug.length === 0 ? "action" : slug}`;
}

function issue(
  code: string,
  message: string,
  relatedIds: string[],
): CaseValidationIssue {
  return caseValidationIssueSchema.parse({ code, message, relatedIds });
}

function deduplicateIssues(
  issues: readonly CaseValidationIssue[],
): CaseValidationIssue[] {
  const unique = new Map<string, CaseValidationIssue>();
  for (const entry of issues) unique.set(canonicalJson(entry), entry);
  return [...unique.values()];
}
