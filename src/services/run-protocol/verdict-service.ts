import { canonicalJson, sha256Canonical } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import { assertJsonValue } from "../../core/json-value.js";
import { validateRunLifecycleHistory } from "../../core/runs/lifecycle.js";
import { RunRepository } from "../../core/runs/repository.js";
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
import { resolveTrustedProject } from "../project-root/resolve-trusted-project.js";
import { validateProtocolEvents } from "./run-protocol-service.js";

export interface VerdictEntry {
  event: RunEvent;
  payload: VerdictPayload;
}

export class VerdictService {
  private readonly runId: string;

  constructor(
    private readonly projectRoot: string,
    private readonly aiQaHome: string,
    runId: string,
    private readonly now: () => Date,
  ) {
    this.runId = runIdSchema.parse(runId);
  }

  async recordBlocker(input: BlockerPayload): Promise<RunEvent> {
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
      return blockerAppendInput(payload);
    });
  }

  async set(input: VerdictPayload): Promise<RunEvent> {
    const payload = verdictPayloadSchema.parse(input);
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
      if (verdicts.length !== 0) {
        throw new AiQaError(
          "verdict.already_set",
          "Use verdict revise after the initial verdict",
        );
      }
      return verdictAppendInput(payload);
    });
  }

  async revise(
    input: VerdictPayload & { supersedes: string },
  ): Promise<RunEvent> {
    const payload = verdictPayloadSchema.parse(input);
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
      const candidate = verdictAppendInput(payload);
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
    const repository = await this.trustedRepository();
    return repository.journal(this.runId).readLocked(async (events) => {
      const workOrder = await repository.readVerifiedWorkOrder(this.runId);
      validateProtocolEvents(events, workOrder, this.runId);
      validateRunLifecycleHistory(events, this.runId);
      return effectiveVerdictFrom(validateVerdictHistory(events, workOrder))
        ?.event;
    });
  }

  private async appendValidated(
    prepare: (
      workOrder: WorkOrder,
      events: readonly RunEvent[],
      verdicts: readonly VerdictEntry[],
    ) => AppendRunEvent,
  ): Promise<RunEvent> {
    const repository = await this.trustedRepository();
    return repository.journal(this.runId).appendPrepared(async (events) => {
      const workOrder = await repository.readVerifiedWorkOrder(this.runId);
      validateProtocolEvents(events, workOrder, this.runId);
      validateRunLifecycleHistory(events, this.runId);
      const verdicts = validateVerdictHistory(events, workOrder);
      return {
        input: prepare(workOrder, events, verdicts),
        resolve: (event: RunEvent) => event,
      };
    });
  }

  private async trustedRepository(): Promise<RunRepository> {
    const trusted = await resolveTrustedProject({
      cwd: this.projectRoot,
      explicitProject: this.projectRoot,
      aiQaHome: this.aiQaHome,
    });
    return new RunRepository(trusted.projectRoot, this.now);
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
    for (const event of events) {
      if (event.type === "blocker") {
        const payload = blockerPayloadSchema.parse(event.payload);
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
        const payload = verdictPayloadSchema.parse(event.payload);
        if (
          !payload.criterionResults.every((result) =>
            knownCriteria.has(result.criterionId),
          )
        ) {
          throw new Error("invalid verdict criterion");
        }
        if (
          payload.supersedes !== undefined &&
          !verdicts.some(({ event: prior }) => prior.id === payload.supersedes)
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

function blockerAppendInput(payload: BlockerPayload): AppendRunEvent {
  return typedAppendInput(
    "blocker",
    `blocker:${sha256Canonical(payload)}`,
    payload,
    [...payload.attemptEventIds, ...payload.criterionIds],
  );
}

function verdictAppendInput(payload: VerdictPayload): AppendRunEvent {
  return typedAppendInput(
    "verdict",
    `verdict:${sha256Canonical(payload)}`,
    payload,
    verdictRelatedIds(payload),
  );
}

function typedAppendInput(
  type: "blocker" | "verdict",
  idempotencyKey: string,
  payload: unknown,
  relatedIds: string[],
): AppendRunEvent {
  assertJsonValue(payload);
  return {
    type,
    actor: "agent",
    platform: "web",
    tool: "ai-qa",
    idempotencyKey,
    payload,
    relatedIds,
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
    const parsed = blockerPayloadSchema.safeParse(blocker?.payload);
    if (!parsed.success) {
      throw new AiQaError(
        "verdict.blocker_reference_invalid",
        "Blocked verdicts must cite existing blocker events",
        { blockerId },
      );
    }
    if (parsed.data.subtype !== payload.blockerSubtype) {
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
      isRecord(event.payload) &&
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
