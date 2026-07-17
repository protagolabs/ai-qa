import { AiQaError } from "../../core/errors.js";
import { RunGroupRepository } from "../../core/run-groups/repository.js";
import { runGroupIdSchema } from "../../core/run-groups/schema.js";
import { resolveProject } from "../project-root/resolve-project.js";
import { readRunState } from "../run-protocol/read-run-state.js";
import { cancelRun } from "../run-protocol/run-lifecycle.js";
import { readVerifiedRunGroupMemberStates } from "./finish-run-group.js";
import { materializeRunGroup } from "./materialize-run-group.js";

export async function cancelRunGroup(input: {
  projectRoot: string;
  runGroupId: string;
  reason: string;
  now: () => Date;
}): Promise<{
  runGroupId: string;
  status: "cancelled";
  eventId: string;
  memberRunIds: string[];
}> {
  const runGroupId = runGroupIdSchema.parse(input.runGroupId);
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new AiQaError(
      "run_group.cancel_reason_required",
      "Run-group cancel reason is required",
    );
  }
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  await materializeRunGroup({
    projectRoot: project.projectRoot,
    runGroupId,
    now: input.now,
  });
  const repository = new RunGroupRepository(project.projectRoot, input.now);
  const result = await repository.transition(runGroupId, "cancelled", {
    reason,
    beforeAppend: async (manifest) => {
      const members = await readVerifiedRunGroupMemberStates({
        projectRoot: project.projectRoot,
        manifest,
        now: input.now,
      });
      for (const { member, state } of members) {
        if (state.status === "completed" || state.status === "cancelled") {
          continue;
        }
        try {
          await cancelRun({
            projectRoot: project.projectRoot,
            runId: member.runId,
            reason,
            now: input.now,
          });
        } catch (error: unknown) {
          if (!(error instanceof AiQaError) || error.code !== "run.terminal") {
            throw error;
          }
          const current = await readRunState({
            projectRoot: project.projectRoot,
            runId: member.runId,
            now: input.now,
          });
          if (
            current.status !== "completed" &&
            current.status !== "cancelled"
          ) {
            throw error;
          }
        }
      }
    },
  });
  return {
    runGroupId,
    status: "cancelled",
    eventId: result.event.id,
    memberRunIds: result.manifest.members.map((member) => member.runId),
  };
}
