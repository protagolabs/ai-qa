import { canonicalJson } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import { controllerForPlatform } from "../../core/platforms/registry.js";
import type {
  RequiredStep,
  RunEvent,
  WorkOrder,
} from "../../core/runs/schema.js";
import {
  accumulateEffectiveInteractionEvent,
  createEffectiveInteractionAccumulator,
  effectiveInteractionSuccessFor,
} from "./effective-interactions.js";

export interface RegressionFidelityResult {
  requiredStepIds: string[];
  completedStepIds: string[];
  unresolvedActionIds: string[];
  toolCallCount: number;
  recoveryActionCount: number;
  valid: boolean;
}

type ActionEvent = Extract<RunEvent, { type: "action" }>;
type ObservationEvent = Extract<RunEvent, { type: "observation" }>;
type EvidenceEvent = Extract<RunEvent, { type: "evidence" }>;
type AssertionEvent = Extract<RunEvent, { type: "assertion" }>;
type RecoveryPayload = Extract<RunEvent, { type: "recovery" }>["payload"];

interface PlannedEntry {
  event: ActionEvent;
  payload: Extract<ActionEvent["payload"], { phase: "planned" }>;
}

interface TerminalEntry {
  event: ActionEvent;
  payload: Extract<ActionEvent["payload"], { phase: "completed" | "unknown" }>;
}

interface SuccessfulNormalInteraction {
  terminal: TerminalEntry;
  boundaryEvent: RunEvent;
}

interface LinkedCheckpointState {
  linkedKinds: Set<string>;
  assertionPresent: boolean;
}

export function validateRegressionFidelity(
  workOrder: WorkOrder,
  events: readonly RunEvent[],
): RegressionFidelityResult {
  if (workOrder.kind !== "regression") {
    return {
      requiredStepIds: [],
      completedStepIds: [],
      unresolvedActionIds: [],
      toolCallCount: 0,
      recoveryActionCount: 0,
      valid: true,
    };
  }

  const required = workOrder.requiredSteps;
  const requiredById = new Map(required.map((step) => [step.id, step]));
  const plans = new Map<string, PlannedEntry>();
  const terminals = new Map<string, TerminalEntry>();
  const normalPlans = new Map<string, PlannedEntry[]>();
  const successfulNormal = new Map<string, SuccessfulNormalInteraction>();
  const recoveryResolutions = new Map<string, RecoveryPayload>();
  const completedRecoveryPlanSequenceByStep = new Map<string, number>();
  const observationEvents: ObservationEvent[] = [];
  const evidenceEvents: EvidenceEvent[] = [];
  const assertionEvents: AssertionEvent[] = [];
  let nextIncompleteRequiredIndex = 0;
  let latestStartedNormalOrder = -1;
  let recoveryActionCount = 0;
  let recoveryHistoryValid = true;
  const effectiveInteractions = createEffectiveInteractionAccumulator();
  const recordSuccessfulNormal = (
    stepId: string,
    terminal: TerminalEntry,
    boundaryEvent: RunEvent,
  ): void => {
    if (successfulNormal.has(stepId)) {
      throw replayError(
        "replay.required_step_repeated",
        "A required step may have only one successful normal interaction",
        { stepId },
      );
    }
    successfulNormal.set(stepId, { terminal, boundaryEvent });
    if (required[nextIncompleteRequiredIndex]?.id === stepId) {
      nextIncompleteRequiredIndex += 1;
    }
  };

  for (const event of events) {
    accumulateEffectiveInteractionEvent(effectiveInteractions, event);
    if (event.type === "observation") observationEvents.push(event);
    if (event.type === "evidence") evidenceEvents.push(event);
    if (event.type === "assertion") assertionEvents.push(event);
    if (event.type === "action") {
      const payload = event.payload;
      if (payload.phase !== "planned") {
        const planned = plans.get(payload.actionId);
        if (planned === undefined || terminals.has(payload.actionId)) {
          throw replayError(
            "replay.action_history_invalid",
            "Regression action terminals must resolve one planned action",
            { actionId: payload.actionId },
          );
        }
        const terminal = { event, payload };
        terminals.set(payload.actionId, terminal);
        if (
          planned.payload.recoveryForStepId !== undefined &&
          payload.phase === "completed"
        ) {
          completedRecoveryPlanSequenceByStep.set(
            planned.payload.recoveryForStepId,
            Math.max(
              completedRecoveryPlanSequenceByStep.get(
                planned.payload.recoveryForStepId,
              ) ?? -1,
              planned.event.sequence,
            ),
          );
        }
        if (
          planned.payload.kind === "interaction" &&
          planned.payload.recoveryForStepId === undefined &&
          payload.phase === "completed"
        ) {
          recordSuccessfulNormal(planned.payload.stepId, terminal, event);
        }
        continue;
      }

      const step = requiredById.get(payload.stepId);
      if (step === undefined) {
        throw replayError(
          "replay.unknown_step",
          "Regression actions must reference a required step",
          { stepId: payload.stepId },
        );
      }
      if (event.tool !== controllerForPlatform(workOrder.platform)) {
        throw replayError(
          "replay.tool_mismatch",
          "Regression actions must use the pinned platform tool",
          { stepId: step.id, tool: event.tool },
        );
      }

      if (payload.recoveryForStepId !== undefined) {
        validateRecoveryPlan({
          payload,
          step,
          requiredById,
          normalPlans,
          latestStartedNormalOrder,
        });
        recoveryActionCount += 1;
      } else if (payload.kind === "interaction") {
        validateNormalPlan({
          event,
          payload,
          step,
          expectedStep: required[nextIncompleteRequiredIndex],
          normalPlans,
          terminals,
          recoveryResolutions,
          completedRecoveryPlanSequenceByStep,
        });
        const existing = normalPlans.get(step.id) ?? [];
        existing.push({ event, payload });
        normalPlans.set(step.id, existing);
        latestStartedNormalOrder = Math.max(
          latestStartedNormalOrder,
          step.order,
        );
      } else {
        validateSupportingPlan(
          payload.stepId,
          required,
          nextIncompleteRequiredIndex,
        );
      }
      plans.set(event.id, { event, payload });
      continue;
    }

    if (event.type === "recovery") {
      const payload = event.payload;
      if (recoveryResolutions.has(payload.actionId)) {
        recoveryHistoryValid = false;
      }
      recoveryResolutions.set(payload.actionId, payload);
      if (payload.resolution === "applied") {
        const planned = plans.get(payload.actionId);
        const terminal = terminals.get(payload.actionId);
        const effective = effectiveInteractionSuccessFor(
          effectiveInteractions,
          payload.actionId,
        );
        if (
          planned?.payload.recoveryForStepId !== undefined &&
          terminal?.payload.phase === "unknown"
        ) {
          completedRecoveryPlanSequenceByStep.set(
            planned.payload.recoveryForStepId,
            Math.max(
              completedRecoveryPlanSequenceByStep.get(
                planned.payload.recoveryForStepId,
              ) ?? -1,
              planned.event.sequence,
            ),
          );
        }
        if (
          planned?.payload.kind === "interaction" &&
          planned.payload.recoveryForStepId === undefined &&
          terminal?.payload.phase === "unknown" &&
          effective !== undefined
        ) {
          recordSuccessfulNormal(
            planned.payload.stepId,
            terminal,
            effective.boundaryEvent,
          );
        } else if (planned?.payload.recoveryForStepId === undefined) {
          recoveryHistoryValid = false;
        }
      }
    }
  }

  const unresolvedActionIds = [...plans.values()].flatMap(({ event }) => {
    const terminal = terminals.get(event.id);
    if (terminal === undefined) return [event.id];
    if (
      terminal.payload.phase === "unknown" &&
      !recoveryResolutions.has(event.id)
    ) {
      return [event.id];
    }
    return [];
  });
  const completedStepIds = required
    .filter((step) => successfulNormal.has(step.id))
    .map((step) => step.id);
  const checkpointState = buildLinkedCheckpointState({
    observations: observationEvents,
    evidence: evidenceEvents,
    assertions: assertionEvents,
    plans,
    terminals,
    successfulNormal,
  });
  const checkpointsLinked = required.every((step) => {
    const state = checkpointState.get(step.id);
    return (
      state?.assertionPresent === true &&
      step.evidenceCheckpoints.every((kind) => state.linkedKinds.has(kind))
    );
  });
  const toolCallCount = plans.size;
  const budgetsValid =
    toolCallCount <= workOrder.budget.maxToolCalls &&
    recoveryActionCount <= workOrder.budget.maxRecoveryActions;

  return {
    requiredStepIds: required.map((step) => step.id),
    completedStepIds,
    unresolvedActionIds,
    toolCallCount,
    recoveryActionCount,
    valid:
      completedStepIds.length === required.length &&
      unresolvedActionIds.length === 0 &&
      checkpointsLinked &&
      budgetsValid &&
      recoveryHistoryValid,
  };
}

function validateNormalPlan(input: {
  event: ActionEvent;
  payload: PlannedEntry["payload"];
  step: RequiredStep;
  expectedStep: RequiredStep | undefined;
  normalPlans: ReadonlyMap<string, PlannedEntry[]>;
  terminals: ReadonlyMap<string, TerminalEntry>;
  recoveryResolutions: ReadonlyMap<string, RecoveryPayload>;
  completedRecoveryPlanSequenceByStep: ReadonlyMap<string, number>;
}): void {
  const expected = input.expectedStep;
  if (expected === undefined || input.step.id !== expected.id) {
    throw replayError(
      "replay.step_out_of_order",
      "The next normal interaction must execute the first incomplete required step",
      {
        stepId: input.step.id,
        ...(expected === undefined ? {} : { expectedStepId: expected.id }),
      },
    );
  }
  const prior = input.normalPlans.get(input.step.id) ?? [];
  if (prior.length > 0) {
    const latest = prior.at(-1)!;
    const terminal = input.terminals.get(latest.event.id);
    const resolution = input.recoveryResolutions.get(latest.event.id);
    const completedRecoveryAfterResolution =
      resolution !== undefined &&
      (input.completedRecoveryPlanSequenceByStep.get(input.step.id) ?? -1) >
        latest.event.sequence;
    if (
      terminal?.payload.phase !== "unknown" ||
      resolution?.resolution !== "not_applied" ||
      !completedRecoveryAfterResolution
    ) {
      throw replayError(
        "recovery.marker_required",
        "A repeated required-step interaction must first use a linked recovery action",
        { stepId: input.step.id },
      );
    }
  }

  if (
    input.event.tool !== input.step.tool ||
    input.payload.intent !== input.step.intent ||
    canonicalJson(input.payload.target) !==
      canonicalJson({
        description: input.step.target.description,
        ...(input.step.target.selector === undefined
          ? {}
          : { selector: input.step.target.selector }),
      })
  ) {
    throw replayError(
      "replay.required_step_mismatch",
      "A required normal interaction must match the pinned step",
      { stepId: input.step.id },
    );
  }
}

function validateRecoveryPlan(input: {
  payload: PlannedEntry["payload"];
  step: RequiredStep;
  requiredById: ReadonlyMap<string, RequiredStep>;
  normalPlans: ReadonlyMap<string, PlannedEntry[]>;
  latestStartedNormalOrder: number;
}): void {
  const recoveryStepId = input.payload.recoveryForStepId;
  if (
    recoveryStepId === undefined ||
    input.payload.kind !== "interaction" ||
    input.payload.stepId !== recoveryStepId ||
    !input.requiredById.has(recoveryStepId) ||
    (input.normalPlans.get(recoveryStepId)?.length ?? 0) === 0
  ) {
    throw replayError(
      "replay.recovery_step_invalid",
      "Recovery must stay linked to a started required step",
      { stepId: input.step.id },
    );
  }
  if (input.latestStartedNormalOrder > input.step.order) {
    throw replayError(
      "replay.recovery_out_of_order",
      "Recovery cannot revisit or advance beyond the current required step",
      { stepId: recoveryStepId },
    );
  }
}

function validateSupportingPlan(
  stepId: string,
  required: readonly RequiredStep[],
  nextIncompleteRequiredIndex: number,
): void {
  const allowed = new Set<string>();
  if (nextIncompleteRequiredIndex >= required.length) {
    const last = required.at(-1);
    if (last !== undefined) allowed.add(last.id);
  } else {
    allowed.add(required[nextIncompleteRequiredIndex]!.id);
    if (nextIncompleteRequiredIndex > 0) {
      allowed.add(required[nextIncompleteRequiredIndex - 1]!.id);
    }
  }
  if (!allowed.has(stepId)) {
    throw replayError(
      "replay.supporting_step_out_of_order",
      "Observation and evidence actions must support the current or just-completed required step",
      { stepId },
    );
  }
}

function buildLinkedCheckpointState(input: {
  observations: readonly ObservationEvent[];
  evidence: readonly EvidenceEvent[];
  assertions: readonly AssertionEvent[];
  plans: ReadonlyMap<string, PlannedEntry>;
  terminals: ReadonlyMap<string, TerminalEntry>;
  successfulNormal: ReadonlyMap<string, SuccessfulNormalInteraction>;
}): Map<string, LinkedCheckpointState> {
  const observationsByStep = new Map<string, Set<string>>();
  for (const event of input.observations) {
    const payload = event.payload;
    if (payload.stepId === undefined) continue;
    const success = input.successfulNormal.get(payload.stepId);
    const plan = input.plans.get(payload.actionId);
    const terminal = input.terminals.get(payload.actionId);
    if (
      success === undefined ||
      plan?.payload.kind !== "observation" ||
      plan.payload.stepId !== payload.stepId ||
      plan.event.sequence <= success.boundaryEvent.sequence ||
      terminal?.payload.phase !== "completed" ||
      terminal.event.sequence <= success.boundaryEvent.sequence ||
      event.sequence <= success.boundaryEvent.sequence
    ) {
      continue;
    }
    const observations =
      observationsByStep.get(payload.stepId) ?? new Set<string>();
    observations.add(event.id);
    observationsByStep.set(payload.stepId, observations);
  }

  const checkpointState = new Map<string, LinkedCheckpointState>();
  const linkedEvidenceIdsByStep = new Map<string, Set<string>>();
  for (const event of input.evidence) {
    const payload = event.payload;
    const capture = input.plans.get(payload.captureActionId);
    if (capture === undefined) continue;
    const stepId = capture.payload.stepId;
    const success = input.successfulNormal.get(stepId);
    const terminal = input.terminals.get(payload.captureActionId);
    const observations = observationsByStep.get(stepId);
    if (
      success === undefined ||
      capture.payload.kind !== "evidence-capture" ||
      capture.event.sequence <= success.boundaryEvent.sequence ||
      terminal?.payload.phase !== "completed" ||
      terminal.event.sequence <= success.boundaryEvent.sequence ||
      event.sequence <= success.boundaryEvent.sequence ||
      !payload.observationIds.some((id) => observations?.has(id) === true)
    ) {
      continue;
    }
    const linkedEvidenceIds =
      linkedEvidenceIdsByStep.get(stepId) ?? new Set<string>();
    linkedEvidenceIds.add(payload.id);
    linkedEvidenceIdsByStep.set(stepId, linkedEvidenceIds);
    const state = checkpointState.get(stepId) ?? {
      linkedKinds: new Set<string>(),
      assertionPresent: false,
    };
    for (const kind of payload.evidenceKinds) state.linkedKinds.add(kind);
    checkpointState.set(stepId, state);
  }

  for (const event of input.assertions) {
    const payload = event.payload;
    const stepId = payload.stepId;
    if (stepId === undefined) continue;
    const success = input.successfulNormal.get(stepId);
    const observations = observationsByStep.get(stepId);
    const linkedEvidenceIds = linkedEvidenceIdsByStep.get(stepId);
    if (
      success !== undefined &&
      event.sequence > success.boundaryEvent.sequence &&
      payload.status === "satisfied" &&
      payload.observationIds.some((id) => observations?.has(id) === true) &&
      payload.evidenceIds.some((id) => linkedEvidenceIds?.has(id) === true)
    ) {
      const state = checkpointState.get(stepId) ?? {
        linkedKinds: new Set<string>(),
        assertionPresent: false,
      };
      state.assertionPresent = true;
      for (const kind of payload.assertionKinds) state.linkedKinds.add(kind);
      checkpointState.set(stepId, state);
    }
  }
  return checkpointState;
}

function replayError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AiQaError {
  return new AiQaError(code, message, details);
}
