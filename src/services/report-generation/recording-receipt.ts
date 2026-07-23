import { AiQaError } from "../../core/errors.js";
import { assertNotCompromised } from "../../core/fs/locking.js";
import { RecordingRepository } from "../../core/recording/repository.js";
import {
  recordingReceiptInputSchema,
  type RecordingEvent,
  type RecordingReceiptInput,
  type ReportSubject,
} from "../../core/recording/schema.js";
import type { ProjectSkillSnapshot } from "../../core/runs/schema.js";
import { assertCurrentProjectSkillSnapshot } from "../project-skill/project-skill-file.js";
import {
  withVerifiedGeneratedRunGroupReport,
  type GroupReportOperationInput,
} from "./generate-group-report.js";
import {
  withVerifiedGeneratedRunReport,
  type ReportOperationInput,
} from "./generate-run-report.js";

export type RecordingStatusView =
  | {
      subject: ReportSubject;
      status: "not_applicable";
      references: [];
    }
  | {
      subject: ReportSubject;
      status: "pending";
      references: [];
    }
  | {
      subject: ReportSubject;
      status: "recorded" | "not_recorded" | "unknown";
      references: string[];
      eventId: string;
      recordedAt: string;
    };

interface VerifiedRecordingSubject {
  subject: ReportSubject;
  projectRoot: string;
  directory: string;
  recordingMode: "local-only" | "project-skill";
  projectSkill?: ProjectSkillSnapshot;
  preCommit: () => void;
}

export async function registerRecordingReceipt(
  input: ReportOperationInput & { receipt: RecordingReceiptInput },
): Promise<{
  event: RecordingEvent;
  status: RecordingStatusView;
  replayed: boolean;
}> {
  return registerSubjectRecordingReceipt(
    { kind: "run", id: input.runId },
    input.receipt,
    input.now,
    (operation) =>
      withVerifiedGeneratedRunReport(input, (verified, signal) =>
        operation({
          subject: { kind: "run", id: input.runId },
          projectRoot: verified.projectRoot,
          directory: verified.directory,
          recordingMode: verified.recordingMode,
          preCommit: () => assertNotCompromised(signal, verified.directory),
          ...(verified.projectSkill === undefined
            ? {}
            : { projectSkill: verified.projectSkill }),
        }),
      ),
  );
}

export async function registerGroupRecordingReceipt(
  input: GroupReportOperationInput & { receipt: RecordingReceiptInput },
): Promise<{
  event: RecordingEvent;
  status: RecordingStatusView;
  replayed: boolean;
}> {
  return registerSubjectRecordingReceipt(
    { kind: "run-group", id: input.runGroupId },
    input.receipt,
    input.now,
    (operation) =>
      withVerifiedGeneratedRunGroupReport(input, (verified, signal) =>
        operation({
          subject: { kind: "run-group", id: input.runGroupId },
          projectRoot: verified.projectRoot,
          directory: verified.directory,
          recordingMode: verified.recordingMode,
          preCommit: () => assertNotCompromised(signal, verified.directory),
          ...(verified.projectSkill === undefined
            ? {}
            : { projectSkill: verified.projectSkill }),
        }),
      ),
  );
}

export async function readRecordingStatus(
  input: ReportOperationInput,
): Promise<RecordingStatusView> {
  return readSubjectRecordingStatus(input.now, (operation) =>
    withVerifiedGeneratedRunReport(input, (verified, signal) =>
      operation({
        subject: { kind: "run", id: input.runId },
        projectRoot: verified.projectRoot,
        directory: verified.directory,
        recordingMode: verified.recordingMode,
        preCommit: () => assertNotCompromised(signal, verified.directory),
        ...(verified.projectSkill === undefined
          ? {}
          : { projectSkill: verified.projectSkill }),
      }),
    ),
  );
}

export async function readGroupRecordingStatus(
  input: GroupReportOperationInput,
): Promise<RecordingStatusView> {
  return readSubjectRecordingStatus(input.now, (operation) =>
    withVerifiedGeneratedRunGroupReport(input, (verified, signal) =>
      operation({
        subject: { kind: "run-group", id: input.runGroupId },
        projectRoot: verified.projectRoot,
        directory: verified.directory,
        recordingMode: verified.recordingMode,
        preCommit: () => assertNotCompromised(signal, verified.directory),
        ...(verified.projectSkill === undefined
          ? {}
          : { projectSkill: verified.projectSkill }),
      }),
    ),
  );
}

async function registerSubjectRecordingReceipt(
  subject: ReportSubject,
  receipt: RecordingReceiptInput,
  now: () => Date,
  withVerified: <T>(
    operation: (verified: VerifiedRecordingSubject) => Promise<T>,
  ) => Promise<T>,
): Promise<{
  event: RecordingEvent;
  status: RecordingStatusView;
  replayed: boolean;
}> {
  return withVerified(async (verified) => {
    if (verified.recordingMode !== "project-skill") {
      throw new AiQaError(
        "recording.not_applicable",
        "Recording receipts are not applicable to this report subject",
        subjectDetails(subject),
      );
    }
    const repository = new RecordingRepository(
      verified.directory,
      subject,
      now,
    );
    if (verified.projectSkill === undefined) {
      return replayHistoricalReceipt({
        repository,
        subject,
        receipt,
        preCommit: verified.preCommit,
      });
    }
    await assertCurrentProjectSkillSnapshot({
      projectRoot: verified.projectRoot,
      snapshot: verified.projectSkill,
    });
    const registered = await repository.registerUnlocked(receipt, {
      preCommit: verified.preCommit,
    });
    const current = registered.artifact.history.at(-1);
    if (current === undefined) throw recordingIntegrityError(subject);
    return {
      event: registered.event,
      status: statusFromReceipt(subject, current),
      replayed: registered.replayed,
    };
  });
}

async function readSubjectRecordingStatus(
  now: () => Date,
  withVerified: <T>(
    operation: (verified: VerifiedRecordingSubject) => Promise<T>,
  ) => Promise<T>,
): Promise<RecordingStatusView> {
  return withVerified(async (verified) => {
    if (verified.recordingMode !== "project-skill") {
      return {
        subject: verified.subject,
        status: "not_applicable",
        references: [],
      };
    }
    const repository = new RecordingRepository(
      verified.directory,
      verified.subject,
      now,
    );
    if (verified.projectSkill !== undefined) {
      await assertCurrentProjectSkillSnapshot({
        projectRoot: verified.projectRoot,
        snapshot: verified.projectSkill,
      });
    }
    const state = await repository.readOrRecoverUnlocked({
      preCommit: verified.preCommit,
    });
    if (state.state === "missing") {
      if (verified.projectSkill === undefined) {
        throw projectSkillSnapshotMissing(verified.subject);
      }
      return {
        subject: verified.subject,
        status: "pending",
        references: [],
      };
    }
    const event = state.events.at(-1);
    if (event === undefined) throw recordingIntegrityError(verified.subject);
    return statusFromEvent(event);
  });
}

async function replayHistoricalReceipt(input: {
  repository: RecordingRepository;
  subject: ReportSubject;
  receipt: RecordingReceiptInput;
  preCommit: () => void;
}): Promise<{
  event: RecordingEvent;
  status: RecordingStatusView;
  replayed: boolean;
}> {
  const receipt = recordingReceiptInputSchema.parse(input.receipt);
  const state = await input.repository.readOrRecoverUnlocked({
    preCommit: input.preCommit,
  });
  if (state.state === "missing") {
    throw projectSkillSnapshotMissing(input.subject);
  }
  const registered = await input.repository.registerUnlocked(receipt, {
    preCommit: input.preCommit,
  });
  const current = registered.artifact.history.at(-1);
  if (current === undefined) throw recordingIntegrityError(input.subject);
  return {
    event: registered.event,
    status: statusFromReceipt(input.subject, current),
    replayed: registered.replayed,
  };
}

function statusFromReceipt(
  subject: ReportSubject,
  receipt: Pick<
    RecordingEvent,
    "eventId" | "status" | "references" | "recordedAt"
  >,
): RecordingStatusView {
  return {
    subject,
    status: receipt.status,
    references: receipt.references,
    eventId: receipt.eventId,
    recordedAt: receipt.recordedAt,
  };
}

function statusFromEvent(event: RecordingEvent): RecordingStatusView {
  return statusFromReceipt(event.subject, event);
}

function recordingIntegrityError(subject: ReportSubject): AiQaError {
  return new AiQaError(
    "recording.integrity_error",
    "Recording journal has no current event",
    subjectDetails(subject),
  );
}

function projectSkillSnapshotMissing(subject: ReportSubject): AiQaError {
  return new AiQaError(
    "project_skill.snapshot_missing",
    "Historical project-skill report subject has no frozen Project Skill snapshot",
    subjectDetails(subject),
  );
}

function subjectDetails(
  subject: ReportSubject,
): { runId: string } | { runGroupId: string } {
  return subject.kind === "run"
    ? { runId: subject.id }
    : { runGroupId: subject.id };
}
