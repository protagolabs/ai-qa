import { z } from "zod";
import { canonicalJson, sha256Canonical } from "../../core/canonical-json.js";
import { AiQaError, toErrorCause } from "../../core/errors.js";
import { createId } from "../../core/ids.js";
import { assertJsonValue, jsonValueSchema } from "../../core/json-value.js";
import { controllerForPlatform } from "../../core/platforms/registry.js";
import {
  controllerSchema,
  type Platform,
} from "../../core/platforms/schema.js";
import {
  actionPayloadSchema,
  assertionPayloadSchema,
  decisionPayloadSchema,
  observationPayloadSchema,
  recoveryPayloadSchema,
  type ActionPayload,
  type AssertionPayload,
  type DecisionPayload,
  type ObservationPayload,
  type RecoveryPayload,
} from "../../core/runs/event-payloads.js";
import {
  actionIdSchema,
  runIdSchema,
  stepIdSchema,
  type AppendRunEvent,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import { appendInput } from "../../core/runs/journal.js";
import {
  withRunSession,
  type ProtocolCommandResult,
  type RunSession,
} from "./run-session.js";

export const planActionInputSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1),
    kind: z.enum(["interaction", "observation", "evidence-capture"]),
    intent: z.string().trim().min(1),
    tool: controllerSchema,
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
type ActionEvent = Extract<RunEvent, { type: "action" }>;
type ObservationEvent = Extract<RunEvent, { type: "observation" }>;

interface PlannedAction {
  event: ActionEvent;
  payload: PlannedActionPayload;
}

interface TerminalAction {
  event: ActionEvent;
  payload: TerminalActionPayload;
}

interface RecoveryRetryAccumulator {
  latestInteractionByStep: Map<string, PlannedAction>;
  terminals: Map<string, TerminalAction>;
  resolutions: Map<string, RecoveryPayload>;
}

export class RunProtocolService {
  private readonly runId: string;

  constructor(
    private readonly projectRoot: string,
    runId: string,
    private readonly now: () => Date,
  ) {
    this.runId = runIdSchema.parse(runId);
  }

  async planAction(input: PlanActionInput): Promise<ProtocolCommandResult> {
    const parsed = planActionInputSchema.parse(input);
    let enforceDeadline = true;
    return this.appendValidated(
      (workOrder, events) => {
        requireController(workOrder, parsed.tool);
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
          requireRecoveryRetryPermitted(
            buildRecoveryRetryAccumulator(events),
            parsed.recoveryForStepId,
          );
        } else if (
          workOrder.kind !== "regression" &&
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
        const candidate = actionAppendInput(
          workOrder.platform,
          parsed.tool,
          parsed.idempotencyKey,
          payload,
        );
        return candidate;
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

  async completeAction(
    input: CompleteActionInput,
  ): Promise<ProtocolCommandResult> {
    const parsed = completeActionInputSchema.parse(input);
    return this.appendValidated((workOrder, events) => {
      const planned = requirePlannedAction(events, parsed.actionId);
      const payload = actionPayloadSchema.parse(parsed);
      const candidate = actionAppendInput(
        workOrder.platform,
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

  async addObservation(
    input: ObservationPayload,
  ): Promise<ProtocolCommandResult> {
    const parsed = observationPayloadSchema.parse(input);
    return this.appendValidated((workOrder, events) => {
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
        platform: workOrder.platform,
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

  async recordAssertion(
    input: AssertionPayload,
  ): Promise<ProtocolCommandResult> {
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
        platform: workOrder.platform,
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

  async recordDecision(input: DecisionPayload): Promise<ProtocolCommandResult> {
    const parsed = decisionPayloadSchema.parse(input);
    return this.appendValidated((workOrder) =>
      protocolAppendInput({
        platform: workOrder.platform,
        type: "decision",
        actor: "agent",
        tool: "ai-qa",
        idempotencyKey: `decision:${sha256Canonical(parsed)}`,
        payload: parsed,
        relatedIds: parsed.relatedIds,
      }),
    );
  }

  async resolveUnknownAction(
    input: RecoveryPayload,
  ): Promise<ProtocolCommandResult> {
    const parsed = recoveryPayloadSchema.parse(input);
    return this.appendValidated((workOrder, events) => {
      const planned = requirePlannedAction(events, parsed.actionId);
      const terminal = requireSingleTerminal(
        events,
        parsed.actionId,
        "unknown",
      );
      requireFreshRecoveryObservation(
        events,
        planned,
        terminal,
        parsed.observationId,
      );
      const candidate = protocolAppendInput({
        platform: workOrder.platform,
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
  ): Promise<ProtocolCommandResult> {
    let commandTime: Date | undefined;
    const now = () => (commandTime ??= this.now());
    return withRunSession(
      { projectRoot: this.projectRoot, runId: this.runId, now },
      async (session) => {
        const { events, lifecycle, workOrder } = session.snapshot;
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
        const input = prepare(workOrder, events);
        validateTimestamp?.(workOrder, now().toISOString());
        const event = (await session.append([input]))[0];
        if (event === undefined)
          throw new Error("protocol append returned no event");
        return commandResult(session, event);
      },
    );
  }
}

function requireFreshObservationAfterResume(
  events: readonly RunEvent[],
  actionKind: PlanActionInput["kind"],
): void {
  if (actionKind === "observation") return;
  const resumed = events.findLast((event) => {
    return event.type === "run" && event.payload.phase === "resumed";
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

function requireController(
  workOrder: WorkOrder,
  actualController: string,
): void {
  const expectedController = controllerForPlatform(workOrder.platform);
  if (actualController !== expectedController) {
    throw new AiQaError(
      "run_protocol.controller_mismatch",
      "Action controller must match the immutable run platform",
      {
        runId: workOrder.runId,
        platform: workOrder.platform,
        expectedController,
        actualController,
      },
    );
  }
}

function protocolAppendInput(input: AppendRunEvent): AppendRunEvent {
  assertJsonValue(input.payload);
  return input;
}

function actionAppendInput(
  platform: Platform,
  tool: string,
  idempotencyKey: string,
  payload: ActionPayload,
): AppendRunEvent {
  return protocolAppendInput({
    platform,
    type: "action",
    actor: "agent",
    tool,
    idempotencyKey,
    payload,
    relatedIds: payload.phase === "planned" ? [] : [payload.actionId],
  });
}

function commandResult(
  session: RunSession,
  event: RunEvent,
): ProtocolCommandResult {
  const { permittedNextActions, ...state } = session.state();
  return { event, state, permittedNextActions };
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
  const payload = event.payload;
  if (payload.phase !== "planned") return false;
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
    const payload = event.payload;
    return payload.phase === "planned" ? [{ event, payload }] : [];
  });
}

function terminalActions(
  events: readonly RunEvent[],
  actionId: string,
): TerminalAction[] {
  return events.flatMap((event) => {
    if (event.type !== "action") return [];
    const payload = event.payload;
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
  state: RecoveryRetryAccumulator,
  stepId: string,
): void {
  const latest = state.latestInteractionByStep.get(stepId);
  if (latest === undefined) {
    throw retryNotPermitted(stepId);
  }
  const terminal = state.terminals.get(latest.event.id);
  if (terminal === undefined) {
    throw retryNotPermitted(stepId, latest.event.id);
  }
  if (terminal.payload.phase === "completed") {
    if (latest.payload.recoveryForStepId === undefined) return;
    throw retryNotPermitted(stepId, latest.event.id);
  }

  const resolution = state.resolutions.get(latest.event.id);
  if (resolution?.resolution !== "not_applied") {
    throw retryNotPermitted(stepId, latest.event.id);
  }
}

function buildRecoveryRetryAccumulator(
  events: readonly RunEvent[],
): RecoveryRetryAccumulator {
  const state: RecoveryRetryAccumulator = {
    latestInteractionByStep: new Map(),
    terminals: new Map(),
    resolutions: new Map(),
  };
  for (const event of events) {
    if (event.type === "action") {
      const payload = event.payload;
      if (payload.phase === "planned") {
        accumulateRecoveryRetryPlan(state, { event, payload });
      } else {
        state.terminals.set(payload.actionId, { event, payload });
      }
    } else if (event.type === "recovery") {
      const payload = event.payload;
      state.resolutions.set(payload.actionId, payload);
    }
  }
  return state;
}

function accumulateRecoveryRetryPlan(
  state: RecoveryRetryAccumulator,
  plan: PlannedAction,
): void {
  if (plan.payload.kind !== "interaction") return;
  state.latestInteractionByStep.set(plan.payload.stepId, plan);
  if (plan.payload.recoveryForStepId !== undefined) {
    state.latestInteractionByStep.set(plan.payload.recoveryForStepId, plan);
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

function requireFreshRecoveryObservation(
  events: readonly RunEvent[],
  recoveredPlan: PlannedAction,
  unknownTerminal: TerminalAction,
  observationId: string,
): void {
  const observation = findObservation(events, observationId);
  if (observation === undefined) {
    throw freshRecoveryObservationRequired(
      recoveredPlan.event.id,
      observationId,
    );
  }
  const observationPayload = observation.payload;
  const observationPlan = requirePlannedAction(
    events,
    observationPayload.actionId,
  );
  const observationTerminal = requireSingleTerminal(
    events,
    observationPayload.actionId,
    "completed",
  );
  if (
    observationPlan.event.sequence <= unknownTerminal.event.sequence ||
    observationTerminal.event.sequence <= unknownTerminal.event.sequence ||
    observation.sequence <= unknownTerminal.event.sequence
  ) {
    throw freshRecoveryObservationRequired(
      recoveredPlan.event.id,
      observationId,
    );
  }
  if (
    observationPlan.payload.kind !== "observation" ||
    observationPlan.payload.stepId !== recoveredPlan.payload.stepId ||
    observationPayload.stepId !== recoveredPlan.payload.stepId
  ) {
    throw protocolIntegrityError(
      new Error("recovery observation does not match the recovered action"),
    );
  }
}

function freshRecoveryObservationRequired(
  actionId: string,
  observationId: string,
): AiQaError {
  return new AiQaError(
    "recovery.fresh_observation_required",
    "A fresh observation is required to resolve an unknown action",
    { actionId, observationId },
  );
}

function findObservation(
  events: readonly RunEvent[],
  observationId: string,
): ObservationEvent | undefined {
  const matches = events.filter(
    (event): event is ObservationEvent =>
      event.id === observationId && event.type === "observation",
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function requireEvidence(
  events: readonly RunEvent[],
  evidenceId: string,
  runId: string,
): void {
  const matches = events.filter((event) => {
    if (event.type !== "evidence") return false;
    return event.payload.id === evidenceId && event.payload.runId === runId;
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
  options: { evidenceParityAuthoritative?: boolean } = {},
): void {
  try {
    const eventIdOwners = new Map<string, RunEvent["type"]>();
    const idempotencyKeyOwners = new Map<string, RunEvent["type"]>();
    const plans = new Map<string, PlannedAction>();
    const terminals = new Map<string, TerminalAction>();
    const observations = new Map<string, ObservationEvent>();
    const observationActions = new Set<string>();
    const evidenceIds = new Set<string>();
    const recoveryResolutions = new Map<string, RecoveryPayload>();
    const interactionSteps = new Set<string>();
    const plannedSteps = new Set<string>();
    const recoveryRetryState: RecoveryRetryAccumulator = {
      latestInteractionByStep: new Map<string, PlannedAction>(),
      terminals,
      resolutions: recoveryResolutions,
    };
    const knownCriteria = new Set(
      workOrder.acceptanceCriteria.map((criterion) => criterion.id),
    );
    let plannedCount = 0;
    let recoveryCount = 0;

    for (const event of events) {
      requireSemantic(event.platform === workOrder.platform);
      const eventIdOwner = eventIdOwners.get(event.id);
      requireSemantic(
        eventIdOwner === undefined ||
          (options.evidenceParityAuthoritative === true &&
            eventIdOwner === "evidence" &&
            event.type === "evidence"),
      );
      if (eventIdOwner === undefined) {
        eventIdOwners.set(event.id, event.type);
      }
      if (event.idempotencyKey !== undefined) {
        const owner = idempotencyKeyOwners.get(event.idempotencyKey);
        requireSemantic(
          owner === undefined ||
            (options.evidenceParityAuthoritative === true &&
              owner === "evidence" &&
              event.type === "evidence"),
        );
        if (owner === undefined) {
          idempotencyKeyOwners.set(event.idempotencyKey, event.type);
        }
      }

      switch (event.type) {
        case "action": {
          const payload = event.payload;
          if (payload.phase === "planned") {
            requireProtocolMetadata(event, {
              actor: "agent",
              tool: event.tool,
              idempotencyKey: event.idempotencyKey,
              relatedIds: [],
            });
            requireSemantic(
              event.tool === controllerForPlatform(workOrder.platform),
            );
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
              requireSemantic(plannedSteps.has(payload.recoveryForStepId));
              requireSemantic(
                recoveryCount < workOrder.budget.maxRecoveryActions,
              );
              requireRecoveryRetryPermitted(
                recoveryRetryState,
                payload.recoveryForStepId,
              );
              recoveryCount += 1;
            } else if (
              payload.kind === "interaction" &&
              workOrder.kind !== "regression"
            ) {
              requireSemantic(!interactionSteps.has(payload.stepId));
            }
            if (payload.kind === "interaction") {
              interactionSteps.add(payload.stepId);
            }
            const plan = { event, payload };
            plans.set(event.id, plan);
            plannedSteps.add(payload.stepId);
            accumulateRecoveryRetryPlan(recoveryRetryState, plan);
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
          const terminal = { event, payload };
          terminals.set(payload.actionId, terminal);
          break;
        }
        case "observation": {
          const payload = event.payload;
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
          const payload = event.payload;
          requireSemantic(knownCriteria.has(payload.criterionId));
          requireSemantic(
            payload.observationIds.every((id) => observations.has(id)),
          );
          requireSemantic(
            payload.evidenceIds.every((id) => evidenceIds.has(id)),
          );
          if (payload.stepId !== undefined) {
            requireSemantic(plannedSteps.has(payload.stepId));
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
          const payload = event.payload;
          const plan = plans.get(payload.captureActionId);
          const terminal = terminals.get(payload.captureActionId);
          requireSemantic(payload.runId === runId);
          requireSemantic(plan?.payload.kind === "evidence-capture");
          requireSemantic(terminal?.payload.phase === "completed");
          requireSemantic(payload.platform === workOrder.platform);
          requireSemantic(
            payload.sourceTool === controllerForPlatform(workOrder.platform),
          );
          requireSemantic(payload.sourceTool === plan?.event.tool);
          requireSemantic(
            payload.criterionIds.every((id) => knownCriteria.has(id)),
          );
          requireSemantic(
            payload.observationIds.every((id) => observations.has(id)),
          );
          requireSemantic(
            options.evidenceParityAuthoritative === true ||
              !evidenceIds.has(payload.id),
          );
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
          const payload = event.payload;
          requireProtocolMetadata(event, {
            actor: "agent",
            tool: "ai-qa",
            idempotencyKey: `decision:${sha256Canonical(payload)}`,
            relatedIds: payload.relatedIds,
          });
          break;
        }
        case "recovery": {
          const payload = event.payload;
          const plan = plans.get(payload.actionId);
          const terminal = terminals.get(payload.actionId);
          const observation = observations.get(payload.observationId);
          requireSemantic(plan !== undefined);
          requireSemantic(terminal?.payload.phase === "unknown");
          requireSemantic(observation !== undefined);
          const observationPayload = observation.payload;
          const observationPlan = plans.get(observationPayload.actionId);
          const observationTerminal = terminals.get(
            observationPayload.actionId,
          );
          requireSemantic(observationPlan?.payload.kind === "observation");
          requireSemantic(observationTerminal?.payload.phase === "completed");
          requireSemantic(observationPayload.stepId === plan.payload.stepId);
          requireSemantic(
            observationPlan.payload.stepId === plan.payload.stepId,
          );
          requireSemantic(
            observationPlan.event.sequence > terminal.event.sequence,
          );
          requireSemantic(
            observationTerminal.event.sequence > terminal.event.sequence,
          );
          requireSemantic(observation.sequence > terminal.event.sequence);
          requireSemantic(!recoveryResolutions.has(payload.actionId));
          requireProtocolMetadata(event, {
            actor: "ai-qa",
            tool: "ai-qa",
            idempotencyKey: `recovery:${payload.actionId}`,
            relatedIds: [payload.actionId, payload.observationId],
          });
          recoveryResolutions.set(payload.actionId, payload);
          break;
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw protocolIntegrityError(error);
  }
}

function protocolIntegrityError(cause: unknown): AiQaError {
  return new AiQaError(
    "run_protocol.integrity_error",
    "Typed run protocol event validation failed",
    { cause: toErrorCause(cause) },
  );
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
