import { z } from "zod";
import { canonicalJson, sha256Canonical } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import { createId } from "../../core/ids.js";
import { assertJsonValue, jsonValueSchema } from "../../core/json-value.js";
import {
  actionPayloadSchema,
  assertionPayloadSchema,
  decisionPayloadSchema,
  evidenceEventPayloadSchema,
  observationPayloadSchema,
  recoveryPayloadSchema,
  type ActionPayload,
  type AssertionPayload,
  type DecisionPayload,
  type ObservationPayload,
  type RecoveryPayload,
} from "../../core/runs/event-payloads.js";
import { validateRunLifecycleHistory } from "../../core/runs/lifecycle.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  actionIdSchema,
  runIdSchema,
  stepIdSchema,
  type AppendRunEvent,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import { resolveTrustedProject } from "../project-root/resolve-trusted-project.js";

export const planActionInputSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1),
    kind: z.enum(["interaction", "observation", "evidence-capture"]),
    intent: z.string().trim().min(1),
    tool: z.string().trim().min(1),
    target: z
      .object({
        description: z.string().trim().min(1),
        selector: z.string().trim().min(1).optional(),
      })
      .strict(),
    stepId: stepIdSchema.optional(),
    recoveryForStepId: stepIdSchema.optional(),
  })
  .strict();

export type PlanActionInput = z.infer<typeof planActionInputSchema>;

export const completeActionInputSchema = z
  .object({
    actionId: actionIdSchema,
    phase: z.enum(["completed", "unknown"]),
    toolResult: z
      .object({
        summary: z.string().trim().min(1),
        data: jsonValueSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type CompleteActionInput = z.infer<typeof completeActionInputSchema>;

type PlannedActionPayload = Extract<ActionPayload, { phase: "planned" }>;
type TerminalActionPayload = Extract<
  ActionPayload,
  { phase: "completed" | "unknown" }
>;

interface PlannedAction {
  event: RunEvent;
  payload: PlannedActionPayload;
}

interface TerminalAction {
  event: RunEvent;
  payload: TerminalActionPayload;
}

export class RunProtocolService {
  private readonly runId: string;

  constructor(
    private readonly projectRoot: string,
    private readonly aiQaHome: string,
    runId: string,
    private readonly now: () => Date,
  ) {
    this.runId = runIdSchema.parse(runId);
  }

  async planAction(input: PlanActionInput): Promise<RunEvent> {
    const parsed = planActionInputSchema.parse(input);
    let enforceDeadline = true;
    return this.appendValidated(
      (workOrder, events) => {
        const existing = events.find(
          (event) => event.idempotencyKey === parsed.idempotencyKey,
        );
        if (existing !== undefined) {
          if (!matchesPlanRetry(existing, parsed)) {
            throw idempotencyConflict(parsed.idempotencyKey);
          }
          enforceDeadline = false;
          return appendInput(existing);
        }

        requireFreshObservationAfterResume(events, parsed.kind);

        const planned = plannedActions(events);
        if (planned.length >= workOrder.budget.maxToolCalls) {
          throw new AiQaError(
            "run.tool_call_budget_exhausted",
            "The frozen tool-call budget has been exhausted",
            {
              runId: this.runId,
              maxToolCalls: workOrder.budget.maxToolCalls,
            },
          );
        }
        if (parsed.recoveryForStepId !== undefined) {
          if (parsed.kind !== "interaction") {
            throw new AiQaError(
              "recovery.interaction_required",
              "Recovery actions must be state-changing interactions",
              { recoveryForStepId: parsed.recoveryForStepId },
            );
          }
          if (
            parsed.stepId !== undefined &&
            parsed.stepId !== parsed.recoveryForStepId
          ) {
            throw new AiQaError(
              "recovery.step_mismatch",
              "A recovery action must stay on the affected step",
              {
                stepId: parsed.stepId,
                recoveryForStepId: parsed.recoveryForStepId,
              },
            );
          }
          requireKnownStep(planned, parsed.recoveryForStepId);
          const recoveryCount = planned.filter(
            ({ payload }) => payload.recoveryForStepId !== undefined,
          ).length;
          if (recoveryCount >= workOrder.budget.maxRecoveryActions) {
            throw new AiQaError(
              "run.recovery_budget_exhausted",
              "The frozen recovery-action budget has been exhausted",
              {
                runId: this.runId,
                maxRecoveryActions: workOrder.budget.maxRecoveryActions,
              },
            );
          }
          requireRecoveryRetryPermitted(events, parsed.recoveryForStepId);
        } else if (
          parsed.kind === "interaction" &&
          parsed.stepId !== undefined &&
          planned.some(
            ({ payload }) =>
              payload.kind === "interaction" &&
              payload.stepId === parsed.stepId,
          )
        ) {
          throw new AiQaError(
            "recovery.marker_required",
            "A repeated interaction step must declare recoveryForStepId",
            { stepId: parsed.stepId },
          );
        }

        const payload = actionPayloadSchema.parse({
          phase: "planned",
          kind: parsed.kind,
          intent: parsed.intent,
          stepId: parsed.stepId ?? parsed.recoveryForStepId ?? createId("step"),
          target: parsed.target,
          ...(parsed.recoveryForStepId === undefined
            ? {}
            : { recoveryForStepId: parsed.recoveryForStepId }),
        });
        return actionAppendInput(parsed.tool, parsed.idempotencyKey, payload);
      },
      (workOrder, timestamp) => {
        if (
          enforceDeadline &&
          new Date(timestamp).getTime() >=
            new Date(workOrder.budget.deadline).getTime()
        ) {
          throw new AiQaError(
            "run.deadline_exhausted",
            "The frozen run deadline has been reached",
            {
              runId: this.runId,
              deadline: workOrder.budget.deadline,
            },
          );
        }
      },
    );
  }

  async completeAction(input: CompleteActionInput): Promise<RunEvent> {
    const parsed = completeActionInputSchema.parse(input);
    return this.appendValidated((_workOrder, events) => {
      const planned = requirePlannedAction(events, parsed.actionId);
      const payload = actionPayloadSchema.parse(parsed);
      const candidate = actionAppendInput(
        planned.event.tool,
        `complete:${parsed.actionId}`,
        payload,
      );
      const terminals = terminalActions(events, parsed.actionId);
      if (terminals.length === 0) return candidate;
      if (
        terminals.length === 1 &&
        canonicalJson(appendInput(terminals[0]!.event)) ===
          canonicalJson(candidate)
      ) {
        return candidate;
      }
      throw new AiQaError(
        "action.terminal_conflict",
        "A different terminal result is already recorded for this action",
        { actionId: parsed.actionId },
      );
    });
  }

  async addObservation(input: ObservationPayload): Promise<RunEvent> {
    const parsed = observationPayloadSchema.parse(input);
    return this.appendValidated((_workOrder, events) => {
      const planned = requirePlannedAction(events, parsed.actionId);
      if (planned.payload.kind !== "observation") {
        throw new AiQaError(
          "observation.action_required",
          "Observation must reference a planned observation action",
          { actionId: parsed.actionId },
        );
      }
      requireSingleTerminal(events, parsed.actionId, "completed");
      if (
        parsed.stepId !== undefined &&
        parsed.stepId !== planned.payload.stepId
      ) {
        throw new AiQaError(
          "observation.step_mismatch",
          "Observation step must match its action step",
          { actionId: parsed.actionId, stepId: parsed.stepId },
        );
      }
      const payload = observationPayloadSchema.parse({
        ...parsed,
        stepId: planned.payload.stepId,
      });
      const candidate = protocolAppendInput({
        type: "observation",
        actor: "agent",
        tool: planned.event.tool,
        idempotencyKey: `observation:${parsed.actionId}`,
        payload,
        relatedIds: [parsed.actionId],
      });
      requireCanonicalRetryOrNoExisting(
        events,
        candidate.idempotencyKey!,
        candidate,
        "observation.conflict",
      );
      return candidate;
    });
  }

  async recordAssertion(input: AssertionPayload): Promise<RunEvent> {
    const parsed = assertionPayloadSchema.parse(input);
    return this.appendValidated((workOrder, events) => {
      if (
        !workOrder.acceptanceCriteria.some(
          (criterion) => criterion.id === parsed.criterionId,
        )
      ) {
        throw invalidAssertionCitation("criterion", parsed.criterionId);
      }
      for (const observationId of parsed.observationIds) {
        requireObservation(events, observationId);
      }
      for (const evidenceId of parsed.evidenceIds) {
        requireEvidence(events, evidenceId, this.runId);
      }
      if (parsed.stepId !== undefined) {
        requireKnownStep(plannedActions(events), parsed.stepId);
      }
      const candidate = protocolAppendInput({
        type: "assertion",
        actor: "agent",
        tool: "ai-qa",
        idempotencyKey: `assertion:${sha256Canonical(parsed)}`,
        payload: parsed,
        relatedIds: [...parsed.observationIds, ...parsed.evidenceIds],
      });
      return candidate;
    });
  }

  async recordDecision(input: DecisionPayload): Promise<RunEvent> {
    const parsed = decisionPayloadSchema.parse(input);
    return this.appendValidated(() =>
      protocolAppendInput({
        type: "decision",
        actor: "agent",
        tool: "ai-qa",
        idempotencyKey: `decision:${sha256Canonical(parsed)}`,
        payload: parsed,
        relatedIds: parsed.relatedIds,
      }),
    );
  }

  async resolveUnknownAction(input: RecoveryPayload): Promise<RunEvent> {
    const parsed = recoveryPayloadSchema.parse(input);
    return this.appendValidated((_workOrder, events) => {
      requirePlannedAction(events, parsed.actionId);
      const terminal = requireSingleTerminal(
        events,
        parsed.actionId,
        "unknown",
      );
      const observation = findObservation(events, parsed.observationId);
      if (
        observation === undefined ||
        observation.sequence <= terminal.event.sequence
      ) {
        throw new AiQaError(
          "recovery.fresh_observation_required",
          "A fresh observation is required to resolve an unknown action",
          { actionId: parsed.actionId, observationId: parsed.observationId },
        );
      }
      const candidate = protocolAppendInput({
        type: "recovery",
        actor: "ai-qa",
        tool: "ai-qa",
        idempotencyKey: `recovery:${parsed.actionId}`,
        payload: parsed,
        relatedIds: [parsed.actionId, parsed.observationId],
      });
      requireCanonicalRetryOrNoExisting(
        events,
        candidate.idempotencyKey!,
        candidate,
        "recovery.resolution_conflict",
      );
      return candidate;
    });
  }

  private async appendValidated(
    prepare: (
      workOrder: WorkOrder,
      events: readonly RunEvent[],
    ) => AppendRunEvent,
    validateTimestamp?: (workOrder: WorkOrder, timestamp: string) => void,
  ): Promise<RunEvent> {
    const trusted = await resolveTrustedProject({
      cwd: this.projectRoot,
      explicitProject: this.projectRoot,
      aiQaHome: this.aiQaHome,
    });
    const repository = new RunRepository(trusted.projectRoot, this.now);
    return repository.journal(this.runId).appendPrepared(async (events) => {
      const workOrder = await repository.readVerifiedWorkOrder(this.runId);
      validateProtocolEvents(events, workOrder, this.runId);
      const lifecycle = validateRunLifecycleHistory(events, this.runId);
      if (lifecycle.current.payload.phase === "interrupted") {
        throw new AiQaError(
          "run.interrupted",
          "Interrupted runs must be resumed or cancelled before protocol work",
          { runEventId: lifecycle.current.event.id },
        );
      }
      if (
        lifecycle.current.payload.phase === "completed" ||
        lifecycle.current.payload.phase === "cancelled"
      ) {
        throw new AiQaError(
          "run.terminal",
          "Completed or cancelled runs cannot accept protocol events",
          { runEventId: lifecycle.current.event.id },
        );
      }
      return {
        input: prepare(workOrder, events),
        ...(validateTimestamp === undefined
          ? {}
          : {
              validateTimestamp: (timestamp: string) =>
                validateTimestamp(workOrder, timestamp),
            }),
        resolve: (event: RunEvent) => event,
      };
    });
  }
}

function requireFreshObservationAfterResume(
  events: readonly RunEvent[],
  actionKind: PlanActionInput["kind"],
): void {
  if (actionKind === "observation") return;
  const resumed = events.findLast((event) => {
    if (event.type !== "run" || !isRecord(event.payload)) return false;
    return event.payload.phase === "resumed";
  });
  if (
    resumed !== undefined &&
    !events.some(
      (event) =>
        event.type === "observation" && event.sequence > resumed.sequence,
    )
  ) {
    throw new AiQaError(
      "run.fresh_observation_required",
      "A fresh observation is required before continuing after resume",
      { resumedEventId: resumed.id },
    );
  }
}

function protocolAppendInput(input: {
  type: "action" | "observation" | "assertion" | "decision" | "recovery";
  actor: "agent" | "ai-qa";
  tool: string;
  idempotencyKey: string;
  payload: unknown;
  relatedIds: string[];
}): AppendRunEvent {
  assertJsonValue(input.payload);
  return {
    type: input.type,
    actor: input.actor,
    platform: "web",
    tool: input.tool,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    relatedIds: input.relatedIds,
  };
}

function actionAppendInput(
  tool: string,
  idempotencyKey: string,
  payload: ActionPayload,
): AppendRunEvent {
  return protocolAppendInput({
    type: "action",
    actor: "agent",
    tool,
    idempotencyKey,
    payload,
    relatedIds: payload.phase === "planned" ? [] : [payload.actionId],
  });
}

function appendInput(event: RunEvent): AppendRunEvent {
  return {
    actor: event.actor,
    platform: event.platform,
    tool: event.tool,
    type: event.type,
    ...(event.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: event.idempotencyKey }),
    payload: event.payload,
    relatedIds: event.relatedIds,
  };
}

function matchesPlanRetry(event: RunEvent, input: PlanActionInput): boolean {
  if (
    event.type !== "action" ||
    event.actor !== "agent" ||
    event.tool !== input.tool ||
    event.relatedIds.length !== 0
  ) {
    return false;
  }
  const parsed = actionPayloadSchema.safeParse(event.payload);
  if (!parsed.success || parsed.data.phase !== "planned") return false;
  const payload = parsed.data;
  return (
    payload.kind === input.kind &&
    payload.intent === input.intent &&
    canonicalJson(payload.target) === canonicalJson(input.target) &&
    (input.stepId === undefined || payload.stepId === input.stepId) &&
    payload.recoveryForStepId === input.recoveryForStepId
  );
}

function plannedActions(events: readonly RunEvent[]): PlannedAction[] {
  return events.flatMap((event) => {
    if (event.type !== "action") return [];
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase === "planned" ? [{ event, payload }] : [];
  });
}

function terminalActions(
  events: readonly RunEvent[],
  actionId: string,
): TerminalAction[] {
  return events.flatMap((event) => {
    if (event.type !== "action") return [];
    const payload = actionPayloadSchema.parse(event.payload);
    return payload.phase !== "planned" && payload.actionId === actionId
      ? [{ event, payload }]
      : [];
  });
}

function requirePlannedAction(
  events: readonly RunEvent[],
  actionId: string,
): PlannedAction {
  const matches = plannedActions(events).filter(
    ({ event }) => event.id === actionId,
  );
  if (matches.length !== 1) {
    throw new AiQaError(
      "action.planned_action_required",
      "Exactly one matching planned action is required",
      { actionId },
    );
  }
  return matches[0]!;
}

function requireSingleTerminal(
  events: readonly RunEvent[],
  actionId: string,
  phase: "completed" | "unknown",
): TerminalAction {
  const terminals = terminalActions(events, actionId);
  if (terminals.length !== 1 || terminals[0]!.payload.phase !== phase) {
    throw new AiQaError(
      phase === "unknown"
        ? "recovery.unknown_action_required"
        : "action.completed_action_required",
      phase === "unknown"
        ? "Exactly one unknown terminal action is required"
        : "Exactly one completed terminal action is required",
      { actionId },
    );
  }
  return terminals[0]!;
}

function requireKnownStep(
  planned: readonly PlannedAction[],
  stepId: string,
): void {
  if (!planned.some(({ payload }) => payload.stepId === stepId)) {
    throw new AiQaError(
      "action.step_not_found",
      "Step must resolve to a planned action in this run",
      { stepId },
    );
  }
}

function requireRecoveryRetryPermitted(
  events: readonly RunEvent[],
  stepId: string,
): void {
  const lineage = plannedActions(events).filter(
    ({ payload }) =>
      payload.kind === "interaction" &&
      (payload.stepId === stepId || payload.recoveryForStepId === stepId),
  );
  const latest = lineage.at(-1);
  if (latest === undefined) {
    throw retryNotPermitted(stepId);
  }
  const terminals = terminalActions(events, latest.event.id);
  if (terminals.length !== 1) {
    throw retryNotPermitted(stepId, latest.event.id);
  }
  const terminal = terminals[0]!;
  if (terminal.payload.phase === "completed") {
    if (latest.payload.recoveryForStepId === undefined) return;
    throw retryNotPermitted(stepId, latest.event.id);
  }

  const resolutions = events.flatMap((event) => {
    if (event.type !== "recovery") return [];
    const payload = recoveryPayloadSchema.parse(event.payload);
    return payload.actionId === latest.event.id ? [{ event, payload }] : [];
  });
  if (
    resolutions.length !== 1 ||
    resolutions[0]!.payload.resolution !== "not_applied"
  ) {
    throw retryNotPermitted(stepId, latest.event.id);
  }
}

function retryNotPermitted(stepId: string, actionId?: string): AiQaError {
  return new AiQaError(
    "recovery.retry_not_permitted",
    "A retry requires the latest step interaction to resolve as not_applied",
    { stepId, ...(actionId === undefined ? {} : { actionId }) },
  );
}

function requireObservation(
  events: readonly RunEvent[],
  observationId: string,
): RunEvent {
  const observation = findObservation(events, observationId);
  if (observation === undefined) {
    throw invalidAssertionCitation("observation", observationId);
  }
  return observation;
}

function findObservation(
  events: readonly RunEvent[],
  observationId: string,
): RunEvent | undefined {
  const matches = events.filter(
    (event) => event.id === observationId && event.type === "observation",
  );
  return matches.length === 1 &&
    observationPayloadSchema.safeParse(matches[0]!.payload).success
    ? matches[0]
    : undefined;
}

function requireEvidence(
  events: readonly RunEvent[],
  evidenceId: string,
  runId: string,
): void {
  const matches = events.filter((event) => {
    if (event.type !== "evidence") return false;
    const payload = evidenceEventPayloadSchema.safeParse(event.payload);
    return (
      payload.success &&
      payload.data.id === evidenceId &&
      payload.data.runId === runId
    );
  });
  if (matches.length !== 1) {
    throw invalidAssertionCitation("evidence", evidenceId);
  }
}

function invalidAssertionCitation(
  kind: "criterion" | "observation" | "evidence",
  id: string,
): AiQaError {
  return new AiQaError(
    "assertion.citation_invalid",
    "Assertion citations must resolve to strict same-run records",
    { kind, id },
  );
}

function requireCanonicalRetryOrNoExisting(
  events: readonly RunEvent[],
  idempotencyKey: string,
  candidate: AppendRunEvent,
  conflictCode: string,
): void {
  const existing = events.find(
    (event) => event.idempotencyKey === idempotencyKey,
  );
  if (
    existing !== undefined &&
    canonicalJson(appendInput(existing)) !== canonicalJson(candidate)
  ) {
    throw new AiQaError(
      conflictCode,
      "A different event is already recorded for this deterministic key",
      { idempotencyKey },
    );
  }
}

export function validateProtocolEvents(
  events: readonly RunEvent[],
  workOrder: WorkOrder,
  runId: string,
): void {
  try {
    const eventIds = new Set<string>();
    const idempotencyKeys = new Set<string>();
    const plans = new Map<string, PlannedAction>();
    const terminals = new Map<string, TerminalAction>();
    const observations = new Map<string, RunEvent>();
    const observationActions = new Set<string>();
    const evidenceIds = new Set<string>();
    const recoveryActions = new Set<string>();
    const interactionSteps = new Set<string>();
    const knownCriteria = new Set(
      workOrder.acceptanceCriteria.map((criterion) => criterion.id),
    );
    let plannedCount = 0;
    let recoveryCount = 0;

    for (const [index, event] of events.entries()) {
      requireSemantic(!eventIds.has(event.id));
      eventIds.add(event.id);
      if (event.idempotencyKey !== undefined) {
        requireSemantic(!idempotencyKeys.has(event.idempotencyKey));
        idempotencyKeys.add(event.idempotencyKey);
      }

      switch (event.type) {
        case "action": {
          const payload = actionPayloadSchema.parse(event.payload);
          if (payload.phase === "planned") {
            requireProtocolMetadata(event, {
              actor: "agent",
              tool: event.tool,
              idempotencyKey: event.idempotencyKey,
              relatedIds: [],
            });
            requireSemantic(event.tool.trim().length > 0);
            requireSemantic(
              typeof event.idempotencyKey === "string" &&
                event.idempotencyKey.trim().length > 0,
            );
            requireSemantic(
              new Date(event.timestamp).getTime() <
                new Date(workOrder.budget.deadline).getTime(),
            );
            requireSemantic(plannedCount < workOrder.budget.maxToolCalls);
            if (payload.recoveryForStepId !== undefined) {
              requireSemantic(payload.kind === "interaction");
              requireSemantic(payload.stepId === payload.recoveryForStepId);
              requireSemantic(
                [...plans.values()].some(
                  ({ payload: planned }) =>
                    planned.stepId === payload.recoveryForStepId,
                ),
              );
              requireSemantic(
                recoveryCount < workOrder.budget.maxRecoveryActions,
              );
              requireRecoveryRetryPermitted(
                events.slice(0, index),
                payload.recoveryForStepId,
              );
              recoveryCount += 1;
            } else if (payload.kind === "interaction") {
              requireSemantic(!interactionSteps.has(payload.stepId));
            }
            if (payload.kind === "interaction") {
              interactionSteps.add(payload.stepId);
            }
            plans.set(event.id, { event, payload });
            plannedCount += 1;
            break;
          }

          const plan = plans.get(payload.actionId);
          requireSemantic(plan !== undefined);
          requireSemantic(!terminals.has(payload.actionId));
          requireProtocolMetadata(event, {
            actor: "agent",
            tool: plan.event.tool,
            idempotencyKey: `complete:${payload.actionId}`,
            relatedIds: [payload.actionId],
          });
          terminals.set(payload.actionId, { event, payload });
          break;
        }
        case "observation": {
          const payload = observationPayloadSchema.parse(event.payload);
          const plan = plans.get(payload.actionId);
          const terminal = terminals.get(payload.actionId);
          requireSemantic(plan?.payload.kind === "observation");
          requireSemantic(terminal?.payload.phase === "completed");
          requireSemantic(!observationActions.has(payload.actionId));
          requireSemantic(payload.stepId === plan.payload.stepId);
          requireProtocolMetadata(event, {
            actor: "agent",
            tool: plan.event.tool,
            idempotencyKey: `observation:${payload.actionId}`,
            relatedIds: [payload.actionId],
          });
          observations.set(event.id, event);
          observationActions.add(payload.actionId);
          break;
        }
        case "assertion": {
          const payload = assertionPayloadSchema.parse(event.payload);
          requireSemantic(knownCriteria.has(payload.criterionId));
          requireSemantic(
            payload.observationIds.every((id) => observations.has(id)),
          );
          requireSemantic(
            payload.evidenceIds.every((id) => evidenceIds.has(id)),
          );
          if (payload.stepId !== undefined) {
            requireSemantic(
              [...plans.values()].some(
                ({ payload: planned }) => planned.stepId === payload.stepId,
              ),
            );
          }
          requireProtocolMetadata(event, {
            actor: "agent",
            tool: "ai-qa",
            idempotencyKey: `assertion:${sha256Canonical(payload)}`,
            relatedIds: [...payload.observationIds, ...payload.evidenceIds],
          });
          break;
        }
        case "evidence": {
          const payload = evidenceEventPayloadSchema.parse(event.payload);
          const plan = plans.get(payload.captureActionId);
          const terminal = terminals.get(payload.captureActionId);
          requireSemantic(payload.runId === runId);
          requireSemantic(plan?.payload.kind === "evidence-capture");
          requireSemantic(terminal?.payload.phase === "completed");
          requireSemantic(
            payload.criterionIds.every((id) => knownCriteria.has(id)),
          );
          requireSemantic(
            payload.observationIds.every((id) => observations.has(id)),
          );
          requireSemantic(!evidenceIds.has(payload.id));
          requireProtocolMetadata(event, {
            actor: "ai-qa",
            tool: "ai-qa",
            idempotencyKey: payload.idempotencyKey,
            relatedIds: [payload.captureActionId, ...payload.observationIds],
          });
          evidenceIds.add(payload.id);
          break;
        }
        case "decision": {
          const payload = decisionPayloadSchema.parse(event.payload);
          requireProtocolMetadata(event, {
            actor: "agent",
            tool: "ai-qa",
            idempotencyKey: `decision:${sha256Canonical(payload)}`,
            relatedIds: payload.relatedIds,
          });
          break;
        }
        case "recovery": {
          const payload = recoveryPayloadSchema.parse(event.payload);
          const terminal = terminals.get(payload.actionId);
          const observation = observations.get(payload.observationId);
          requireSemantic(terminal?.payload.phase === "unknown");
          requireSemantic(observation !== undefined);
          requireSemantic(observation.sequence > terminal.event.sequence);
          requireSemantic(!recoveryActions.has(payload.actionId));
          requireProtocolMetadata(event, {
            actor: "ai-qa",
            tool: "ai-qa",
            idempotencyKey: `recovery:${payload.actionId}`,
            relatedIds: [payload.actionId, payload.observationId],
          });
          recoveryActions.add(payload.actionId);
          break;
        }
      }
    }
  } catch {
    throw new AiQaError(
      "run_protocol.integrity_error",
      "Typed run protocol event validation failed",
    );
  }
}

function requireProtocolMetadata(
  event: RunEvent,
  expected: {
    actor: RunEvent["actor"];
    tool: string;
    idempotencyKey: string | undefined;
    relatedIds: readonly string[];
  },
): void {
  requireSemantic(event.actor === expected.actor);
  requireSemantic(event.tool === expected.tool);
  requireSemantic(event.idempotencyKey === expected.idempotencyKey);
  requireSemantic(
    canonicalJson(event.relatedIds) === canonicalJson(expected.relatedIds),
  );
}

function requireSemantic(condition: boolean): asserts condition {
  if (!condition) throw new Error("semantic protocol invariant failed");
}

function idempotencyConflict(idempotencyKey: string): AiQaError {
  return new AiQaError(
    "event.idempotency_conflict",
    "Idempotency key was already used for a different event",
    { idempotencyKey },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
