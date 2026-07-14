import { canonicalJson } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import { WEB_CONTROLLER } from "../../core/tools.js";
import {
  actionPayloadSchema,
  assertionPayloadSchema,
  evidenceEventPayloadSchema,
  observationPayloadSchema,
  recoveryPayloadSchema,
} from "../../core/runs/event-payloads.js";
import type {
  RequiredStep,
  RunEvent,
  WorkOrder,
} from "../../core/runs/schema.js";
import { effectiveInteractionSuccesses } from "./effective-interactions.js";

export interface RegressionFidelityResult {
  requiredStepIds: string[];
  completedStepIds: string[];
  unresolvedActionIds: string[];
  toolCallCount: number;
  recoveryActionCount: number;
  valid: boolean;
}

interface PlannedEntry {
  event: RunEvent;
  payload: Extract<
    ReturnType<typeof actionPayloadSchema.parse>,
    { phase: "planned" }
  >;
}

interface TerminalEntry {
  event: RunEvent;
  payload: Extract<
    ReturnType<typeof actionPayloadSchema.parse>,
    { phase: "completed" | "unknown" }
  >;
}

interface SuccessfulNormalInteraction {
  terminal: TerminalEntry;
  boundaryEvent: RunEvent;
}

export function validateRegressionFidelity(
  workOrder: WorkOrder,
  events: RunEvent[],
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

  const required = [...workOrder.requiredSteps].sort(
    (left, right) => left.order - right.order,
  );
  const requiredById = new Map(required.map((step) => [step.id, step]));
  const plans = new Map<string, PlannedEntry>();
  const terminals = new Map<string, TerminalEntry>();
  const normalPlans = new Map<string, PlannedEntry[]>();
  const successfulNormal = new Map<string, SuccessfulNormalInteraction>();
  const recoveryResolutions = new Map<
    string,
    ReturnType<typeof recoveryPayloadSchema.parse>
  >();
  let recoveryActionCount = 0;
  let recoveryHistoryValid = true;

  for (const [index, event] of events.entries()) {
    if (event.type === "action") {
      const payload = actionPayloadSchema.parse(event.payload);
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
          planned.payload.kind === "interaction" &&
          planned.payload.recoveryForStepId === undefined &&
          payload.phase === "completed"
        ) {
          if (successfulNormal.has(planned.payload.stepId)) {
            throw replayError(
              "replay.required_step_repeated",
              "A required step may have only one successful normal interaction",
              { stepId: planned.payload.stepId },
            );
          }
          successfulNormal.set(planned.payload.stepId, {
            terminal,
            boundaryEvent: event,
          });
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
      if (event.tool !== WEB_CONTROLLER) {
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
        });
        recoveryActionCount += 1;
      } else if (payload.kind === "interaction") {
        validateNormalPlan({
          event,
          payload,
          step,
          required,
          normalPlans,
          terminals,
          recoveryResolutions,
          plans,
          successfulNormal,
        });
        const existing = normalPlans.get(step.id) ?? [];
        normalPlans.set(step.id, [...existing, { event, payload }]);
      } else {
        validateSupportingPlan(payload.stepId, required, successfulNormal);
      }
      plans.set(event.id, { event, payload });
      continue;
    }

    if (event.type === "recovery") {
      const payload = recoveryPayloadSchema.parse(event.payload);
      if (recoveryResolutions.has(payload.actionId)) {
        recoveryHistoryValid = false;
      }
      recoveryResolutions.set(payload.actionId, payload);
      if (payload.resolution === "applied") {
        const planned = plans.get(payload.actionId);
        const terminal = terminals.get(payload.actionId);
        const effective = effectiveInteractionSuccesses(
          events.slice(0, index + 1),
        ).find((success) => success.actionId === payload.actionId);
        if (
          planned?.payload.kind === "interaction" &&
          planned.payload.recoveryForStepId === undefined &&
          terminal?.payload.phase === "unknown" &&
          effective !== undefined
        ) {
          if (successfulNormal.has(planned.payload.stepId)) {
            throw replayError(
              "replay.required_step_repeated",
              "A required step may have only one successful normal interaction",
              { stepId: planned.payload.stepId },
            );
          }
          successfulNormal.set(planned.payload.stepId, {
            terminal,
            boundaryEvent: effective.boundaryEvent,
          });
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
  const checkpointsLinked = required.every((step) =>
    hasLinkedCheckpoints(step, events, plans, terminals, successfulNormal),
  );
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
  event: RunEvent;
  payload: PlannedEntry["payload"];
  step: RequiredStep;
  required: RequiredStep[];
  normalPlans: ReadonlyMap<string, PlannedEntry[]>;
  terminals: ReadonlyMap<string, TerminalEntry>;
  recoveryResolutions: ReadonlyMap<
    string,
    ReturnType<typeof recoveryPayloadSchema.parse>
  >;
  plans: ReadonlyMap<string, PlannedEntry>;
  successfulNormal: ReadonlyMap<string, SuccessfulNormalInteraction>;
}): void {
  const expected = input.required.find(
    (step) => !input.successfulNormal.has(step.id),
  );
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
    const completedRecoveryAfterResolution = [...input.plans.values()].some(
      (candidate) => {
        if (
          candidate.payload.recoveryForStepId !== input.step.id ||
          resolution === undefined
        ) {
          return false;
        }
        const recoveryTerminal = input.terminals.get(candidate.event.id);
        const recoveryResolution = input.recoveryResolutions.get(
          candidate.event.id,
        );
        return (
          candidate.event.sequence > latest.event.sequence &&
          (recoveryTerminal?.payload.phase === "completed" ||
            (recoveryTerminal?.payload.phase === "unknown" &&
              recoveryResolution?.resolution === "applied"))
        );
      },
    );
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
  const laterStarted = [...input.normalPlans.keys()].some((stepId) => {
    const candidate = input.requiredById.get(stepId);
    return candidate !== undefined && candidate.order > input.step.order;
  });
  if (laterStarted) {
    throw replayError(
      "replay.recovery_out_of_order",
      "Recovery cannot revisit or advance beyond the current required step",
      { stepId: recoveryStepId },
    );
  }
}

function validateSupportingPlan(
  stepId: string,
  required: RequiredStep[],
  successfulNormal: ReadonlyMap<string, SuccessfulNormalInteraction>,
): void {
  const currentIndex = required.findIndex(
    (step) => !successfulNormal.has(step.id),
  );
  const allowed = new Set<string>();
  if (currentIndex === -1) {
    const last = required.at(-1);
    if (last !== undefined) allowed.add(last.id);
  } else {
    allowed.add(required[currentIndex]!.id);
    if (currentIndex > 0) allowed.add(required[currentIndex - 1]!.id);
  }
  if (!allowed.has(stepId)) {
    throw replayError(
      "replay.supporting_step_out_of_order",
      "Observation and evidence actions must support the current or just-completed required step",
      { stepId },
    );
  }
}

function hasLinkedCheckpoints(
  step: RequiredStep,
  events: RunEvent[],
  plans: ReadonlyMap<string, PlannedEntry>,
  terminals: ReadonlyMap<string, TerminalEntry>,
  successfulNormal: ReadonlyMap<string, SuccessfulNormalInteraction>,
): boolean {
  const success = successfulNormal.get(step.id);
  if (success === undefined) return false;
  const observations = new Map(
    events.flatMap((event) => {
      if (event.type !== "observation") return [];
      const payload = observationPayloadSchema.parse(event.payload);
      const plan = plans.get(payload.actionId);
      const terminal = terminals.get(payload.actionId);
      return payload.stepId === step.id &&
        plan?.payload.kind === "observation" &&
        plan.event.sequence > success.boundaryEvent.sequence &&
        terminal?.payload.phase === "completed" &&
        terminal.event.sequence > success.boundaryEvent.sequence &&
        event.sequence > success.boundaryEvent.sequence
        ? [[event.id, event] as const]
        : [];
    }),
  );
  if (observations.size === 0) return false;

  const linkedKinds = new Set<string>();
  const linkedEvidenceIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "evidence") continue;
    const payload = evidenceEventPayloadSchema.parse(event.payload);
    const capture = plans.get(payload.captureActionId);
    const terminal = terminals.get(payload.captureActionId);
    if (
      capture?.payload.kind !== "evidence-capture" ||
      capture.payload.stepId !== step.id ||
      capture.event.sequence <= success.boundaryEvent.sequence ||
      terminal?.payload.phase !== "completed" ||
      terminal.event.sequence <= success.boundaryEvent.sequence ||
      event.sequence <= success.boundaryEvent.sequence ||
      !payload.observationIds.some((id) => observations.has(id))
    ) {
      continue;
    }
    linkedEvidenceIds.add(payload.id);
    for (const kind of payload.evidenceKinds) linkedKinds.add(kind);
  }
  let assertionPresent = false;
  for (const event of events) {
    if (
      event.type !== "assertion" ||
      event.sequence <= success.boundaryEvent.sequence
    ) {
      continue;
    }
    const payload = assertionPayloadSchema.parse(event.payload);
    if (
      payload.status === "satisfied" &&
      payload.stepId === step.id &&
      payload.observationIds.some((id) => observations.has(id)) &&
      payload.evidenceIds.some((id) => linkedEvidenceIds.has(id))
    ) {
      assertionPresent = true;
      for (const kind of payload.assertionKinds) linkedKinds.add(kind);
    }
  }
  const checkpointsPresent = step.evidenceCheckpoints.every((kind) =>
    linkedKinds.has(kind),
  );
  return checkpointsPresent && assertionPresent;
}

function replayError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AiQaError {
  return new AiQaError(code, message, details);
}
