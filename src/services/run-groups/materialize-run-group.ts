import { canonicalJson } from "../../core/canonical-json.js";
import { AiQaError } from "../../core/errors.js";
import { RunGroupRepository } from "../../core/run-groups/repository.js";
import { runGroupIdSchema } from "../../core/run-groups/schema.js";
import { RunRepository } from "../../core/runs/repository.js";
import type { WorkOrder } from "../../core/runs/schema.js";
import { resolveProject } from "../project-root/resolve-project.js";

export async function materializeRunGroup(input: {
  projectRoot: string;
  runGroupId: string;
  now: () => Date;
}): Promise<{
  runGroupId: string;
  status: "materialized";
  eventId: string;
  memberRunIds: string[];
}> {
  const runGroupId = runGroupIdSchema.parse(input.runGroupId);
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const groupRepository = new RunGroupRepository(
    project.projectRoot,
    input.now,
  );
  const runRepository = new RunRepository(project.projectRoot, input.now);
  const result = await groupRepository.materialize(
    runGroupId,
    async (manifest, allowCreate) => {
      for (const member of manifest.members) {
        let stored: WorkOrder;
        try {
          stored = await runRepository.readVerifiedWorkOrder(member.runId);
        } catch (error: unknown) {
          if (!(error instanceof AiQaError) || error.code !== "run.not_found") {
            throw memberIntegrityError(runGroupId, member.runId);
          }
          if (!allowCreate) {
            throw memberIntegrityError(runGroupId, member.runId);
          }
          try {
            await runRepository.create(member.workOrder);
          } catch (createError: unknown) {
            if (
              !(createError instanceof AiQaError) ||
              createError.code !== "run.already_exists"
            ) {
              throw createError;
            }
          }
          try {
            stored = await runRepository.readVerifiedWorkOrder(member.runId);
          } catch {
            throw memberIntegrityError(runGroupId, member.runId);
          }
        }
        if (canonicalJson(stored) !== canonicalJson(member.workOrder)) {
          throw memberIntegrityError(runGroupId, member.runId);
        }
      }
    },
  );
  return {
    runGroupId,
    status: "materialized",
    eventId: result.event.id,
    memberRunIds: result.manifest.members.map((member) => member.runId),
  };
}

function memberIntegrityError(runGroupId: string, runId: string): AiQaError {
  return new AiQaError(
    "run_group.member_integrity_error",
    "Run-group child work order does not match its frozen manifest snapshot",
    { runGroupId, runId },
  );
}
