import { AiQaError } from "../../core/errors.js";
import { RecordingRepository } from "../../core/recording/repository.js";
import type {
  RecordingEvent,
  RecordingReceiptInput,
} from "../../core/recording/schema.js";
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
    const registered = await new RecordingRepository(
      verified.directory,
      input.runId,
      input.now,
    ).registerUnlocked(input.receipt);
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
    const state = await new RecordingRepository(
      verified.directory,
      input.runId,
      input.now,
    ).readOrRecoverUnlocked();
    if (state.state === "missing") {
      return { runId: input.runId, status: "pending", references: [] };
    }
    const event = state.events.at(-1);
    if (event === undefined) throw recordingIntegrityError(input.runId);
    return statusFromEvent(event);
  });
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
