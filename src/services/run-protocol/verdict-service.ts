import { canonicalJson, sha256Canonical } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import { assertJsonValue } from "../../core/json-value.js";
import {
  runIdSchema,
  type AppendRunEvent,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import {
  blockerPayloadSchema,
  verdictPayloadSchema,
  type BlockerPayload,
  type VerdictPayload,
} from "../../core/verdicts/schema.js";
import {
  withRunSession,
  type ProtocolCommandResult,
  type RunSession,
} from "./run-session.js";

export interface VerdictEntry {
  event: Extract<RunEvent, { type: "verdict" }>;
  payload: VerdictPayload;
}

export class VerdictService {
  private readonly runId: string;

  constructor(
    private readonly projectRoot: string,
    runId: string,
    private readonly now: () => Date,
  ) {
    this.runId = runIdSchema.parse(runId);
  }

  async recordBlocker(input: BlockerPayload): Promise<ProtocolCommandResult> {
    const payload = blockerPayloadSchema.parse(input);
    return this.appendValidated((workOrder, events) => {
      requireMutableRun(events);
      requireKnownCriteria(workOrder, payload.criterionIds, "blocker");
      const eventIds = new Set(events.map((event) => event.id));
      for (const attemptEventId of payload.attemptEventIds) {
        if (!eventIds.has(attemptEventId)) {
          throw new AiQaError(
            "blocker.reference_invalid",
            "Blocker attempts must resolve to events in this run",
            { attemptEventId },
          );
        }
      }
      return blockerAppendInput(workOrder.platform, payload);
    });
  }

  async set(input: VerdictPayload): Promise<ProtocolCommandResult> {
    const payload = verdictPayloadSchema.parse(input);
    requireLifecycleOwnedCancellation(payload);
    if (payload.supersedes !== undefined) {
      throw new AiQaError(
        "verdict.supersedes_forbidden",
        "The initial verdict cannot supersede another verdict",
      );
    }
    return this.appendValidated((workOrder, events, verdicts) => {
      requireMutableRun(events);
      requireKnownCriteria(
        workOrder,
        payload.criterionResults.map((result) => result.criterionId),
        "verdict",
      );
      requireBlockedVerdictReferences(events, payload);
      const candidate = verdictAppendInput(workOrder.platform, payload);
      const retry = verdicts.find(
        ({ event }) =>
          event.idempotencyKey === candidate.idempotencyKey &&
          canonicalJson(event.payload) === canonicalJson(payload),
      );
      if (retry !== undefined) return candidate;
      if (verdicts.length !== 0) {
        throw new AiQaError(
          "verdict.already_set",
          "Use verdict revise after the initial verdict",
        );
      }
      return candidate;
    });
  }

  async revise(
    input: VerdictPayload & { supersedes: string },
  ): Promise<ProtocolCommandResult> {
    const payload = verdictPayloadSchema.parse(input);
    requireLifecycleOwnedCancellation(payload);
    if (payload.supersedes === undefined) {
      throw new AiQaError(
        "verdict.supersedes_required",
        "A revised verdict must name the verdict it supersedes",
      );
    }
    return this.appendValidated((workOrder, events, verdicts) => {
      requireMutableRun(events);
      requireKnownCriteria(
        workOrder,
        payload.criterionResults.map((result) => result.criterionId),
        "verdict",
      );
      requireBlockedVerdictReferences(events, payload);
      const candidate = verdictAppendInput(workOrder.platform, payload);
      const retry = verdicts.find(
        ({ event }) =>
          event.idempotencyKey === candidate.idempotencyKey &&
          canonicalJson(event.payload) === canonicalJson(payload),
      );
      if (retry !== undefined) return candidate;

      const current = effectiveVerdictFrom(verdicts);
      if (current === undefined || current.event.id !== payload.supersedes) {
        throw new AiQaError(
          "verdict.supersedes_mismatch",
          "A revision must supersede the current effective verdict",
          {
            supersedes: payload.supersedes,
            currentVerdictId: current?.event.id,
          },
        );
      }
      return candidate;
    });
  }

  async effectiveVerdict(): Promise<RunEvent | undefined> {
    return withRunSession(
      { projectRoot: this.projectRoot, runId: this.runId, now: this.now },
      (session) => session.snapshot.lifecycle.effectiveVerdict?.event,
    );
  }

  private async appendValidated(
    prepare: (
      workOrder: WorkOrder,
      events: readonly RunEvent[],
      verdicts: readonly VerdictEntry[],
    ) => AppendRunEvent,
  ): Promise<ProtocolCommandResult> {
    return withRunSession(
      { projectRoot: this.projectRoot, runId: this.runId, now: this.now },
      async (session) => {
        const { events, lifecycle, workOrder } = session.snapshot;
        if (lifecycle.current.payload.phase === "interrupted") {
          throw new AiQaError(
            "run.interrupted",
            "Interrupted runs must be resumed or cancelled before verdict mutation",
            { runEventId: lifecycle.current.event.id },
          );
        }
        const input = prepare(workOrder, events, verdictEntries(events));
        const event = (await session.append([input]))[0];
        if (event === undefined)
          throw new Error("verdict append returned no event");
        return commandResult(session, event);
      },
    );
  }
}

export function validateVerdictHistory(
  events: readonly RunEvent[],
  workOrder: WorkOrder,
): VerdictEntry[] {
  try {
    const knownCriteria = new Set(
      workOrder.acceptanceCriteria.map((criterion) => criterion.id),
    );
    const priorEventIds = new Set<string>();
    const blockers = new Map<string, BlockerPayload>();
    const verdicts: VerdictEntry[] = [];
    const verdictIds = new Set<string>();
    for (const event of events) {
      if (event.type === "blocker") {
        const payload = event.payload;
        requireMetadata(event, "agent", `blocker:${sha256Canonical(payload)}`, [
          ...payload.attemptEventIds,
          ...payload.criterionIds,
        ]);
        if (
          !payload.attemptEventIds.every((id) => priorEventIds.has(id)) ||
          !payload.criterionIds.every((id) => knownCriteria.has(id))
        ) {
          throw new Error("invalid blocker references");
        }
        blockers.set(event.id, payload);
      } else if (event.type === "verdict") {
        const payload = event.payload;
        requireCanonicalCancellationShape(payload);
        if (
          !payload.criterionResults.every((result) =>
            knownCriteria.has(result.criterionId),
          )
        ) {
          throw new Error("invalid verdict criterion");
        }
        if (
          payload.supersedes !== undefined &&
          !verdictIds.has(payload.supersedes)
        ) {
          throw new Error("invalid verdict predecessor");
        }
        if (
          payload.classification === "blocked" &&
          !payload.blockerIds.every((id) => blockers.has(id))
        ) {
          throw new Error("invalid blocker citation");
        }
        requireMetadata(
          event,
          "agent",
          `verdict:${sha256Canonical(payload)}`,
          verdictRelatedIds(payload),
        );
        verdicts.push({ event, payload });
        verdictIds.add(event.id);
      }
      priorEventIds.add(event.id);
    }
    return verdicts;
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw new AiQaError(
      "run_protocol.integrity_error",
      "Verdict and blocker history validation failed",
    );
  }
}

export function effectiveVerdictFrom(
  verdicts: readonly VerdictEntry[],
): VerdictEntry | undefined {
  const superseded = new Set(
    verdicts.flatMap(({ payload }) =>
      payload.supersedes === undefined ? [] : [payload.supersedes],
    ),
  );
  const effective = verdicts.filter(({ event }) => !superseded.has(event.id));
  if (effective.length > 1) {
    throw new AiQaError(
      "verdict.multiple_effective",
      "Verdict history has multiple unsuperseded verdicts",
      { verdictIds: effective.map(({ event }) => event.id) },
    );
  }
  return effective[0];
}

function verdictEntries(events: readonly RunEvent[]): VerdictEntry[] {
  return events.flatMap((event) =>
    event.type === "verdict" ? [{ event, payload: event.payload }] : [],
  );
}

function commandResult(
  session: RunSession,
  event: RunEvent,
): ProtocolCommandResult {
  const { permittedNextActions, ...state } = session.state();
  return { event, state, permittedNextActions };
}

function blockerAppendInput(
  platform: WorkOrder["platform"],
  payload: BlockerPayload,
): AppendRunEvent {
  return typedAppendInput(platform, {
    type: "blocker",
    idempotencyKey: `blocker:${sha256Canonical(payload)}`,
    payload,
    relatedIds: [...payload.attemptEventIds, ...payload.criterionIds],
  });
}

function verdictAppendInput(
  platform: WorkOrder["platform"],
  payload: VerdictPayload,
): AppendRunEvent {
  return typedAppendInput(platform, {
    type: "verdict",
    idempotencyKey: `verdict:${sha256Canonical(payload)}`,
    payload,
    relatedIds: verdictRelatedIds(payload),
  });
}

type TypedAppendInputByType = {
  [Type in "blocker" | "verdict"]: {
    type: Type;
    idempotencyKey: string;
    payload: Extract<AppendRunEvent, { type: Type }>["payload"];
    relatedIds: string[];
  };
};

type TypedAppendInput = TypedAppendInputByType[keyof TypedAppendInputByType];

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type ExpectFalse<Value extends false> = Value;
type VerdictAppendMismatchRejected = ExpectFalse<
  IsAssignable<
    {
      type: "blocker" | "verdict";
      idempotencyKey: string;
      payload: VerdictPayload;
      relatedIds: string[];
    },
    TypedAppendInput
  >
>;

function typedAppendInput(
  platform: WorkOrder["platform"],
  input: VerdictAppendMismatchRejected extends false ? TypedAppendInput : never,
): AppendRunEvent {
  assertJsonValue(input.payload);
  return {
    actor: "agent",
    platform,
    tool: "ai-qa",
    ...input,
  };
}

function verdictRelatedIds(payload: VerdictPayload): string[] {
  return [
    ...(payload.supersedes === undefined ? [] : [payload.supersedes]),
    ...(payload.classification === "blocked" ? payload.blockerIds : []),
    ...payload.criterionResults.flatMap((result) => [
      ...result.assertionIds,
      ...result.evidenceIds,
    ]),
  ];
}

function requireLifecycleOwnedCancellation(payload: VerdictPayload): void {
  if (
    payload.classification === "not_verified" &&
    payload.reasonCode === "cancelled"
  ) {
    throw new AiQaError(
      "verdict.cancel_requires_lifecycle",
      "Cancelled verdicts can only be created by run cancel",
    );
  }
}

function requireCanonicalCancellationShape(payload: VerdictPayload): void {
  if (
    payload.classification === "not_verified" &&
    payload.reasonCode === "cancelled" &&
    payload.criterionResults.length !== 0
  ) {
    throw new AiQaError(
      "run_protocol.integrity_error",
      "Cancellation verdicts cannot contain criterion results",
    );
  }
}

function requireMetadata(
  event: RunEvent,
  actor: RunEvent["actor"],
  idempotencyKey: string,
  relatedIds: string[],
): void {
  if (
    event.actor !== actor ||
    event.tool !== "ai-qa" ||
    event.idempotencyKey !== idempotencyKey ||
    canonicalJson(event.relatedIds) !== canonicalJson(relatedIds)
  ) {
    throw new Error("invalid verdict metadata");
  }
}

function requireKnownCriteria(
  workOrder: WorkOrder,
  criterionIds: readonly string[],
  kind: "blocker" | "verdict",
): void {
  const known = new Set(
    workOrder.acceptanceCriteria.map((criterion) => criterion.id),
  );
  for (const criterionId of criterionIds) {
    if (!known.has(criterionId)) {
      throw new AiQaError(
        `${kind}.reference_invalid`,
        `${kind} criterion must exist in the immutable work order`,
        { criterionId },
      );
    }
  }
}

function requireBlockedVerdictReferences(
  events: readonly RunEvent[],
  payload: VerdictPayload,
): void {
  if (payload.classification !== "blocked") return;
  for (const blockerId of payload.blockerIds) {
    const blocker = events.find(
      (event) => event.id === blockerId && event.type === "blocker",
    );
    if (blocker?.type !== "blocker") {
      throw new AiQaError(
        "verdict.blocker_reference_invalid",
        "Blocked verdicts must cite existing blocker events",
        { blockerId },
      );
    }
    if (blocker.payload.subtype !== payload.blockerSubtype) {
      throw new AiQaError(
        "verdict.blocker_subtype_mismatch",
        "Blocked verdict subtype must match every cited blocker",
        { blockerId, blockerSubtype: payload.blockerSubtype },
      );
    }
  }
}

function requireMutableRun(events: readonly RunEvent[]): void {
  const terminal = events.find(
    (event) =>
      event.type === "run" &&
      (event.payload.phase === "completed" ||
        event.payload.phase === "cancelled"),
  );
  if (terminal !== undefined) {
    throw new AiQaError(
      "run.terminal",
      "Completed or cancelled runs cannot change verdict state",
      { runEventId: terminal.id },
    );
  }
}
