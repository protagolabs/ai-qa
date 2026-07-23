import { readProjectConfig } from "../../core/config/repository.js";
import {
  configuredPlatforms,
  projectConfigSchema,
  type ProjectConfig,
} from "../../core/config/schema.js";
import { AiQaError } from "../../core/errors.js";
import {
  ensureProjectLocalDirectory,
  sweepStaleStaging,
} from "../../core/fs/project-storage.js";
import { createId } from "../../core/ids.js";
import type { Platform } from "../../core/platforms/schema.js";
import { RunRepository, runStagingPrefix } from "../../core/runs/repository.js";
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
  platform: Platform;
  payload: ExploratoryRunInput;
  now: () => Date;
  projectConfig?: ProjectConfig;
}): Promise<WorkOrder> {
  const project = await resolveProject({
    cwd: input.projectRoot,
    explicitProject: input.projectRoot,
  });
  const config = projectConfigSchema.parse(
    input.projectConfig ?? (await readProjectConfig(project.projectRoot)),
  );
  const payload = exploratoryRunInputSchema.parse(input.payload);
  if (!configuredPlatforms(config).includes(input.platform)) {
    throw new AiQaError(
      "platform.unconfigured",
      "Run platform is not configured",
      {
        platform: input.platform,
        configuredPlatforms: configuredPlatforms(config),
      },
    );
  }
  if (payload.readiness.platform !== input.platform) {
    throw new AiQaError(
      "platform.mismatch",
      "Run readiness does not match the selected platform",
      {
        selectedPlatform: input.platform,
        readinessPlatform: payload.readiness.platform,
      },
    );
  }
  if (payload.readiness.status !== "ready") {
    throw new AiQaError(
      "doctor.not_ready",
      "Normal execution requires ready platform checks",
    );
  }
  const projectSkill =
    config.recordingPolicy.mode === "project-skill"
      ? await readProjectSkillSnapshot(project.projectRoot)
      : undefined;
  const workOrder = createExploratoryWorkOrder({
    platform: input.platform,
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
  const runsRoot = await ensureProjectLocalDirectory(project.projectRoot, [
    ".ai-qa",
    "runs",
  ]);
  await sweepStaleStaging(runsRoot, runStagingPrefix, input.now);
  await new RunRepository(project.projectRoot, input.now).create(workOrder);
  return workOrder;
}
