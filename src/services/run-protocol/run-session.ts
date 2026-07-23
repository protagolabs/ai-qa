import { canonicalJson } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import {
  assertNotCompromised,
  type LockSignal,
} from "../../core/fs/locking.js";
import { createId } from "../../core/ids.js";
import {
  validateRunLifecycleHistory,
  type LifecycleEntry,
} from "../../core/runs/lifecycle.js";
import { appendInput } from "../../core/runs/journal.js";
import { resolveRunPaths } from "../../core/runs/paths.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  runEventSchema,
  runIdSchema,
  type AppendRunEvent,
  type RunEvent,
  type WorkOrder,
} from "../../core/runs/schema.js";
import { EVENT_SCHEMA_VERSION } from "../../schemas/versions.js";
import { resolveProject } from "../project-root/resolve-project.js";
import { requireNoIncompleteRepair } from "../run-repair/repair-run.js";
import { deriveRunState, type RunStateSummary } from "./read-run-state.js";
import { validateRegressionFidelity } from "./regression-fidelity.js";
import { validateProtocolEvents } from "./run-protocol-service.js";
import {
  effectiveVerdictFrom,
  validateVerdictHistory,
  type VerdictEntry,
} from "./verdict-service.js";

type LifecycleRunEvent = Extract<RunEvent, { type: "run" }>;

export interface LifecycleState {
  readonly current: LifecycleEntry<LifecycleRunEvent>;
  readonly effectiveVerdict?: VerdictEntry;
}

export interface RunSnapshot {
  readonly workOrder: Readonly<WorkOrder>;
  readonly events: readonly RunEvent[];
  readonly lifecycle: LifecycleState;
}

export interface RunInspectionSnapshot {
  readonly workOrder: Readonly<WorkOrder>;
  readonly events: readonly Readonly<RunEvent>[];
}

export interface SessionCommandState {
  readonly state: RunStateSummary;
  readonly permittedNextActions: readonly string[];
}

export interface ProtocolCommandResult extends SessionCommandState {
  readonly event: RunEvent;
}

export interface RunSession {
  readonly snapshot: RunSnapshot;
  append(inputs: readonly AppendRunEvent[]): Promise<readonly RunEvent[]>;
  state(): RunStateSummary & {
    readonly permittedNextActions: readonly string[];
  };
}

interface SessionGuard {
  readonly signal: LockSignal;
  readonly path: string;
}

const validatedLifecycle = new WeakMap<RunSnapshot, LifecycleState>();
const sessionGuards = new WeakMap<RunSession, SessionGuard>();
const preparedEventIds = new WeakMap<AppendRunEvent, string>();

export function validateRunSnapshot(snapshot: RunSnapshot): void {
  const { events, workOrder } = snapshot;
  const runId = workOrder.runId;
  validateProtocolEvents(events, workOrder, runId);
  const lifecycle = validateRunLifecycleHistory(events, runId);
  const effectiveVerdict = effectiveVerdictFrom(
    validateVerdictHistory(events, workOrder),
  );
  if (workOrder.kind === "regression") {
    validateRegressionFidelity(workOrder, [...events]);
  }
  const derivedLifecycle: LifecycleState = {
    current: {
      event: lifecycle.current.event,
      payload: lifecycle.current.payload,
    },
    ...(effectiveVerdict === undefined ? {} : { effectiveVerdict }),
  };
  if (
    snapshot.lifecycle !== undefined &&
    !hasCanonicalLifecycle(snapshot.lifecycle, derivedLifecycle)
  ) {
    throw new AiQaError(
      "run_protocol.integrity_error",
      "Run snapshot lifecycle does not match its event history",
      { runId },
    );
  }
  validatedLifecycle.set(snapshot, derivedLifecycle);
}

export async function withRunSession<T>(
  input: {
    projectRoot: string;
    runId: string;
    now: () => Date;
    beforeValidate?: (snapshot: RunInspectionSnapshot) => Promise<void>;
  },
  callback: (session: RunSession) => T | Promise<T>,
): Promise<T> {
  const runId = runIdSchema.parse(input.runId);
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const repository = new RunRepository(project.projectRoot, input.now);
  const journal = repository.journal(runId);
  const journalPath = resolveRunPaths(project.projectRoot, runId).events;
  return journal.readLocked(
    async (events, signal) => {
      const workOrder = await repository.readVerifiedWorkOrder(runId, events);
      await input.beforeValidate?.(createRunInspection(workOrder, events));
      const snapshot = createValidatedSnapshot(workOrder, events);
      const session = new LockedRunSession(
        runId,
        journal,
        signal,
        journalPath,
        input.now,
        snapshot,
      );
      sessionGuards.set(session, { signal, path: journalPath });
      try {
        return await callback(session);
      } finally {
        sessionGuards.delete(session);
      }
    },
    {
      beforeRead: () => requireNoIncompleteRepair(project.projectRoot, runId),
    },
  );
}

export function assertRunSessionActive(session: RunSession): void {
  const guard = sessionGuards.get(session);
  if (guard === undefined) {
    throw new AiQaError(
      "storage.lock_compromised",
      "Run session is no longer inside its journal critical section",
    );
  }
  assertNotCompromised(guard.signal, guard.path);
}

export function withPreparedRunEventId(
  input: AppendRunEvent,
  eventId: string,
): AppendRunEvent {
  preparedEventIds.set(input, eventId);
  return input;
}

export function sessionCommandState(session: RunSession): SessionCommandState {
  const { permittedNextActions, ...state } = session.state();
  return {
    state: Object.freeze(state),
    permittedNextActions: Object.freeze([...permittedNextActions]),
  };
}

class LockedRunSession implements RunSession {
  private currentSnapshot: RunSnapshot;

  constructor(
    private readonly runId: string,
    private readonly journal: ReturnType<RunRepository["journal"]>,
    private readonly signal: LockSignal,
    private readonly journalPath: string,
    private readonly now: () => Date,
    snapshot: RunSnapshot,
  ) {
    this.currentSnapshot = snapshot;
  }

  get snapshot(): RunSnapshot {
    assertRunSessionActive(this);
    return this.currentSnapshot;
  }

  async append(
    inputs: readonly AppendRunEvent[],
  ): Promise<readonly RunEvent[]> {
    assertRunSessionActive(this);
    const priorEvents = this.currentSnapshot.events;
    const prospectiveEvents = [...priorEvents];
    const resolvedEvents: RunEvent[] = [];
    const createdEvents: RunEvent[] = [];
    const timestamp =
      inputs.length === 0 ? undefined : this.now().toISOString();

    for (const input of inputs) {
      requireImmutablePlatform(
        this.runId,
        this.currentSnapshot.workOrder.platform,
        input,
      );
      const existing = prospectiveEvents.find(
        (event) =>
          input.idempotencyKey !== undefined &&
          event.idempotencyKey === input.idempotencyKey,
      );
      if (existing !== undefined) {
        if (canonicalJson(appendInput(existing)) === canonicalJson(input)) {
          resolvedEvents.push(existing);
          continue;
        }
        throw new AiQaError(
          "event.idempotency_conflict",
          "Idempotency key was already used for a different event",
          { idempotencyKey: input.idempotencyKey },
        );
      }
      const event = runEventSchema.parse({
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: preparedEventIds.get(input) ?? createId("event"),
        runId: this.runId,
        sequence: (prospectiveEvents.at(-1)?.sequence ?? 0) + 1,
        timestamp,
        ...input,
      });
      prospectiveEvents.push(event);
      createdEvents.push(event);
      resolvedEvents.push(event);
    }

    const prospective = createValidatedSnapshot(
      this.currentSnapshot.workOrder,
      prospectiveEvents,
    );
    if (createdEvents.length !== 0) {
      assertNotCompromised(this.signal, this.journalPath);
      if (inputs.length === 1 && createdEvents.length === 1) {
        await this.journal.appendLine(createdEvents[0]!, this.signal);
      } else {
        await this.journal.appendBatch(createdEvents, priorEvents, this.signal);
      }
    }
    this.currentSnapshot = prospective;
    const prospectiveById = new Map(
      prospective.events.map((event) => [event.id, event]),
    );
    return Object.freeze(
      resolvedEvents.map((event) => {
        const immutableEvent = prospectiveById.get(event.id);
        if (immutableEvent === undefined) {
          throw new Error("validated append result is missing");
        }
        return immutableEvent;
      }),
    );
  }

  state(): RunStateSummary & {
    readonly permittedNextActions: readonly string[];
  } {
    assertRunSessionActive(this);
    return deriveRunState(this.currentSnapshot);
  }
}

function createValidatedSnapshot(
  workOrder: Readonly<WorkOrder>,
  events: readonly RunEvent[],
): RunSnapshot {
  const immutableWorkOrder = immutableClone(workOrder);
  const immutableEvents = immutableClone([...events]);
  const candidate: RunSnapshot = {
    workOrder: immutableWorkOrder,
    events: immutableEvents,
    lifecycle: undefined as never,
  };
  validateRunSnapshot(candidate);
  const lifecycle = validatedLifecycle.get(candidate);
  if (lifecycle === undefined) {
    throw new Error("validated lifecycle state was not derived");
  }
  return deepFreeze({
    workOrder: immutableWorkOrder,
    events: candidate.events,
    lifecycle,
  });
}

function createRunInspection(
  workOrder: Readonly<WorkOrder>,
  events: readonly RunEvent[],
): RunInspectionSnapshot {
  return immutableClone({
    workOrder,
    events: [...events],
  });
}

function hasCanonicalLifecycle(
  supplied: LifecycleState,
  derived: LifecycleState,
): boolean {
  try {
    return canonicalJson(supplied) === canonicalJson(derived);
  } catch {
    return false;
  }
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function requireImmutablePlatform(
  runId: string,
  platform: WorkOrder["platform"],
  input: AppendRunEvent,
): void {
  if (input.platform !== platform) {
    throw new AiQaError(
      "journal.integrity_error",
      "Run journal integrity verification failed",
      { runId },
    );
  }
}
