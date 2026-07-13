import { readProjectConfig } from "../../core/config/repository.js";
import { AiQaError } from "../../core/errors.js";
import { createId } from "../../core/ids.js";
import { RunRepository } from "../../core/runs/repository.js";
import {
  createExploratoryWorkOrder,
  exploratoryRunInputSchema,
  type ExploratoryRunInput,
  type WorkOrder,
} from "../../core/runs/schema.js";
import { resolveTrustedProject } from "../project-root/resolve-trusted-project.js";

export async function startExploratoryRun(input: {
  projectRoot: string;
  aiQaHome: string;
  payload: ExploratoryRunInput;
  now: () => Date;
}): Promise<WorkOrder> {
  const trusted = await resolveTrustedProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
    aiQaHome: input.aiQaHome,
  });
  const config = await readProjectConfig(trusted.projectRoot);
  const payload = exploratoryRunInputSchema.parse(input.payload);
  if (payload.readiness.status !== "ready") {
    throw new AiQaError(
      "doctor.not_ready",
      "Normal execution requires a ready Web doctor result",
    );
  }
  const workOrder = createExploratoryWorkOrder({
    projectId: config.project.id,
    runId: createId("run"),
    input: payload,
    evidencePolicy: {
      screenshots: config.evidencePolicy.screenshots,
      defaultSensitivity: config.evidencePolicy.defaultSensitivity,
    },
    startedAt: input.now(),
  });
  await new RunRepository(trusted.projectRoot, input.now).create(workOrder);
  return workOrder;
}
