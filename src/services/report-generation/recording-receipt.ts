import { AiQaError } from "../../core/errors.js";
import { RecordingRepository } from "../../core/recording/repository.js";
import {
  recordingReceiptInputSchema,
  type RecordingEvent,
  type RecordingReceiptInput,
} from "../../core/recording/schema.js";
import { assertCurrentProjectSkillSnapshot } from "../project-skill/project-skill-file.js";
import {
  withVerifiedGeneratedRunReport,
  type ReportOperationInput,
} from "./generate-run-report.js";

export type RecordingStatusView =
  | {
      runId: string;
      status: "not_applicable";
      references: [];
    }
  | {
      runId: string;
      status: "pending";
      references: [];
    }
  | {
      runId: string;
      status: "recorded" | "not_recorded" | "unknown";
      references: string[];
      eventId: string;
      recordedAt: string;
    };

export async function registerRecordingReceipt(
  input: ReportOperationInput & { receipt: RecordingReceiptInput },
): Promise<{
  event: RecordingEvent;
  status: RecordingStatusView;
  replayed: boolean;
}> {
  return withVerifiedGeneratedRunReport(input, async (verified) => {
    if (verified.recordingMode !== "project-skill") {
      throw new AiQaError(
        "recording.not_applicable",
        "Recording receipts are not applicable to this run",
        { runId: input.runId },
      );
    }
    const repository = new RecordingRepository(
      verified.directory,
      input.runId,
      input.now,
    );
    if (verified.projectSkill === undefined) {
      return replayHistoricalReceipt({
        repository,
        runId: input.runId,
        receipt: input.receipt,
      });
    }
    await assertCurrentProjectSkillSnapshot({
      projectRoot: verified.projectRoot,
      snapshot: verified.projectSkill,
    });
    const registered = await repository.registerUnlocked(input.receipt);
    const current = registered.artifact.history.at(-1);
    if (current === undefined) throw recordingIntegrityError(input.runId);
    return {
      event: registered.event,
      status: statusFromReceipt(input.runId, current),
      replayed: registered.replayed,
    };
  });
}

export async function readRecordingStatus(
  input: ReportOperationInput,
): Promise<RecordingStatusView> {
  return withVerifiedGeneratedRunReport(input, async (verified) => {
    if (verified.recordingMode !== "project-skill") {
      return {
        runId: input.runId,
        status: "not_applicable",
        references: [],
      };
    }
    const repository = new RecordingRepository(
      verified.directory,
      input.runId,
      input.now,
    );
    if (verified.projectSkill !== undefined) {
      await assertCurrentProjectSkillSnapshot({
        projectRoot: verified.projectRoot,
        snapshot: verified.projectSkill,
      });
    }
    const state = await repository.readOrRecoverUnlocked();
    if (state.state === "missing") {
      if (verified.projectSkill === undefined) {
        throw projectSkillSnapshotMissing(input.runId);
      }
      return { runId: input.runId, status: "pending", references: [] };
    }
    const event = state.events.at(-1);
    if (event === undefined) throw recordingIntegrityError(input.runId);
    return statusFromEvent(event);
  });
}

async function replayHistoricalReceipt(input: {
  repository: RecordingRepository;
  runId: string;
  receipt: RecordingReceiptInput;
}): Promise<{
  event: RecordingEvent;
  status: RecordingStatusView;
  replayed: boolean;
}> {
  const receipt = recordingReceiptInputSchema.parse(input.receipt);
  const state = await input.repository.readOrRecoverUnlocked();
  if (state.state === "missing") {
    throw projectSkillSnapshotMissing(input.runId);
  }
  const registered = await input.repository.registerUnlocked(receipt);
  const current = registered.artifact.history.at(-1);
  if (current === undefined) throw recordingIntegrityError(input.runId);
  return {
    event: registered.event,
    status: statusFromReceipt(input.runId, current),
    replayed: registered.replayed,
  };
}

function statusFromReceipt(
  runId: string,
  receipt: Pick<
    RecordingEvent,
    "eventId" | "status" | "references" | "recordedAt"
  >,
): RecordingStatusView {
  return {
    runId,
    status: receipt.status,
    references: receipt.references,
    eventId: receipt.eventId,
    recordedAt: receipt.recordedAt,
  };
}

function statusFromEvent(event: RecordingEvent): RecordingStatusView {
  return statusFromReceipt(event.runId, event);
}

function recordingIntegrityError(runId: string): AiQaError {
  return new AiQaError(
    "recording.integrity_error",
    "Recording journal has no current event",
    { runId },
  );
}

function projectSkillSnapshotMissing(runId: string): AiQaError {
  return new AiQaError(
    "project_skill.snapshot_missing",
    "Historical project-skill run has no frozen Project Skill snapshot",
    { runId },
  );
}
