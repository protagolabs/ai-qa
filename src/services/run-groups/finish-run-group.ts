import { canonicalJson } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import { RunGroupRepository } from "../../core/run-groups/repository.js";
import {
  runGroupIdSchema,
  type RunGroupManifest,
  type RunGroupMember,
} from "../../core/run-groups/schema.js";
import { RunRepository } from "../../core/runs/repository.js";
import type { WorkOrder } from "../../core/runs/schema.js";
import { resolveProject } from "../project-root/resolve-project.js";
import {
  readRunState,
  type RunStateSnapshot,
} from "../run-protocol/read-run-state.js";

export async function finishRunGroup(input: {
  projectRoot: string;
  runGroupId: string;
  now: () => Date;
}): Promise<{
  runGroupId: string;
  status: "completed";
  eventId: string;
  memberRunIds: string[];
}> {
  const runGroupId = runGroupIdSchema.parse(input.runGroupId);
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const repository = new RunGroupRepository(project.projectRoot, input.now);
  const result = await repository.transition(runGroupId, "completed", {
    beforeAppend: async (manifest) => {
      const states = await readVerifiedRunGroupMemberStates({
        projectRoot: project.projectRoot,
        manifest,
        now: input.now,
      });
      const nonTerminal = states.filter(
        ({ state }) =>
          state.status !== "completed" && state.status !== "cancelled",
      );
      if (nonTerminal.length > 0) {
        throw new AiQaError(
          "run_group.members_not_terminal",
          "Every run-group member must be terminal before group completion",
          { runGroupId, runIds: nonTerminal.map(({ member }) => member.runId) },
        );
      }
    },
  });
  return {
    runGroupId,
    status: "completed",
    eventId: result.event.id,
    memberRunIds: result.manifest.members.map((member) => member.runId),
  };
}

export async function readVerifiedRunGroupMemberStates(input: {
  projectRoot: string;
  manifest: RunGroupManifest;
  now: () => Date;
}): Promise<
  Array<{
    member: RunGroupMember;
    workOrder: WorkOrder;
    state: RunStateSnapshot;
  }>
> {
  const repository = new RunRepository(input.projectRoot, input.now);
  const result = [];
  for (const member of input.manifest.members) {
    const workOrder = await repository.readVerifiedWorkOrder(member.runId);
    requireMemberIdentity(input.manifest, member, workOrder);
    const state = await readRunState({
      projectRoot: input.projectRoot,
      runId: member.runId,
      now: input.now,
    });
    result.push({ member, workOrder, state });
  }
  return result;
}

function requireMemberIdentity(
  manifest: RunGroupManifest,
  member: RunGroupMember,
  workOrder: WorkOrder,
): void {
  const pinned = workOrder.pinnedCase;
  if (
    workOrder.kind !== "regression" ||
    workOrder.runId !== member.runId ||
    workOrder.runGroupId !== manifest.id ||
    workOrder.projectId !== manifest.projectId ||
    workOrder.execution !== manifest.execution ||
    workOrder.platform !== member.platform ||
    pinned === undefined ||
    pinned.caseId !== member.caseId ||
    pinned.revision !== member.revision ||
    pinned.caseContentHash !== member.caseContentHash ||
    pinned.platformVariantHash !== member.platformVariantHash ||
    canonicalJson(workOrder.budget) !== canonicalJson(member.budget)
  ) {
    throw new AiQaError(
      "run_group.member_integrity_error",
      "Run-group member work order does not match its immutable manifest",
      { runGroupId: manifest.id, runId: member.runId },
    );
  }
}
