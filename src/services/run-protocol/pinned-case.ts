import { CaseRepository } from "../../core/cases/repository.js";
import {
  calculateCaseContentHash,
  calculatePlatformVariantHash,
} from "../../core/cases/schema.js";
import { AiQaError } from "../../core/errors.js";
import type { WorkOrder } from "../../core/runs/schema.js";

export async function validatePinnedRegressionCase(
  projectRoot: string,
  workOrder: WorkOrder,
): Promise<void> {
  const pinned = workOrder.pinnedCase;
  if (pinned === undefined) {
    throw new AiQaError(
      "work_order.integrity_error",
      "Regression work order is missing its pinned case",
      { runId: workOrder.runId },
    );
  }
  const repository = new CaseRepository(projectRoot);
  let revision;
  try {
    revision = await repository.validateRevision(
      pinned.caseId,
      pinned.revision,
    );
  } catch (error: unknown) {
    if (
      !(error instanceof AiQaError) ||
      error.code !== "case.content_hash_mismatch"
    ) {
      throw error;
    }
    try {
      revision = await repository.readRevision(pinned.caseId, pinned.revision);
    } catch {
      throw error;
    }
    let actual: PinnedHashes;
    try {
      actual = calculatePinnedHashes(workOrder, revision);
    } catch {
      throw error;
    }
    if (
      pinned.caseContentHash === actual.caseContentHash &&
      pinned.platformVariantHash === actual.platformVariantHash
    ) {
      throw error;
    }
    throw pinnedHashMismatch(workOrder, actual);
  }
  const actual = calculatePinnedHashes(workOrder, revision);
  if (
    pinned.caseContentHash !== actual.caseContentHash ||
    pinned.platformVariantHash !== actual.platformVariantHash
  ) {
    throw pinnedHashMismatch(workOrder, actual);
  }
}

interface PinnedHashes {
  caseContentHash: string;
  platformVariantHash: string;
}

function calculatePinnedHashes(
  workOrder: WorkOrder,
  revision: Awaited<ReturnType<CaseRepository["readRevision"]>>,
): PinnedHashes {
  return {
    caseContentHash: calculateCaseContentHash(revision),
    platformVariantHash: calculatePlatformVariantHash(
      revision,
      workOrder.platform,
    ),
  };
}

function pinnedHashMismatch(
  workOrder: WorkOrder,
  actual: PinnedHashes,
): AiQaError {
  const pinned = workOrder.pinnedCase!;
  return new AiQaError(
    "case.content_hash_mismatch",
    "Pinned regression case or platform variant hash verification failed",
    {
      caseId: pinned.caseId,
      revision: pinned.revision,
      expectedCaseContentHash: pinned.caseContentHash,
      actualCaseContentHash: actual.caseContentHash,
      expectedPlatformVariantHash: pinned.platformVariantHash,
      actualPlatformVariantHash: actual.platformVariantHash,
    },
  );
}
