import { readProjectConfig } from "../../core/config/repository.js";
import {
  projectConfigSchema,
  type EffectiveProjectConfig,
} from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import { createId } from "../../core/ids.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  type ExploratoryRunInput,
  type WorkOrder,
} from "../../core/runs/schema.js";
import { readProjectSkillSnapshot } from "../project-skill/project-skill-file.js";
import { resolveProject } from "../project-root/resolve-project.js";

export async function startExploratoryRun(input: {
  projectRoot: string;
  payload: ExploratoryRunInput;
  now: () => Date;
  projectConfig?: EffectiveProjectConfig;
}): Promise<WorkOrder> {
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const config = projectConfigSchema.parse(
    input.projectConfig ?? (await readProjectConfig(project.projectRoot)),
  );
  const payload = exploratoryRunInputSchema.parse(input.payload);
  if (payload.readiness.status !== "ready") {
    throw new AiQaError(
      "doctor.not_ready",
      "Normal execution requires a ready Web doctor result",
    );
  }
  const projectSkill =
    config.recordingPolicy.mode === "project-skill"
      ? await readProjectSkillSnapshot(project.projectRoot)
      : undefined;
  const workOrder = createExploratoryWorkOrder({
    projectId: config.project.id,
    runId: createId("run"),
    input: payload,
    evidencePolicy: {
      screenshots: config.evidencePolicy.screenshots,
      defaultSensitivity: config.evidencePolicy.defaultSensitivity,
    },
    recordingPolicy: config.recordingPolicy,
    ...(projectSkill === undefined ? {} : { projectSkill }),
    startedAt: input.now(),
  });
  await new RunRepository(project.projectRoot, input.now).create(workOrder);
  return workOrder;
}
