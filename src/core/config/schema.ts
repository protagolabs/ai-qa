import { z } from "zod";
import { targetSchemas, toolSchemas } from "../platforms/registry.js";
import { platformSchema, type Platform } from "../platforms/schema.js";

const targetsSchema = z
  .object({
    web: targetSchemas.web.optional(),
    "ios-simulator": targetSchemas["ios-simulator"].optional(),
    "android-emulator": targetSchemas["android-emulator"].optional(),
  })
  .strict()
  .refine(
    (targets) =>
      platformSchema.options.some(
        (platform) => targets[platform] !== undefined,
      ),
    { message: "Configure at least one platform target" },
  );

const toolsSchema = z
  .object({
    web: toolSchemas.web.optional(),
    "ios-simulator": toolSchemas["ios-simulator"].optional(),
    "android-emulator": toolSchemas["android-emulator"].optional(),
  })
  .strict();

const recordingModeSchema = z.enum(["local-only", "project-skill"]);

export const projectConfigV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    project: z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
      name: z.string().min(1),
    }),
    targets: targetsSchema,
    environments: z.record(z.string(), z.unknown()),
    tools: toolsSchema,
    evidencePolicy: z.object({
      screenshots: z.enum(["required", "on-failure", "optional"]),
      defaultSensitivity: z.enum(["public", "internal", "sensitive"]),
      retentionDays: z.number().int().positive(),
    }),
    reportPolicy: z.object({
      formats: z.array(z.enum(["markdown", "json"])).min(1),
      audience: z.string().min(1),
      detail: z.enum(["summary", "full"]),
    }),
    recordingPolicy: z.object({ mode: recordingModeSchema }),
    storagePolicy: z.object({ adapter: z.literal("project-local") }),
    gitPolicy: z.object({
      config: z.enum(["track", "ignore"]),
      artifacts: z.enum(["track", "ignore"]),
    }),
    ciPolicy: z.object({ nonPassExit: z.literal("failure") }),
    secretReferences: z.record(
      z.string(),
      z
        .string()
        .regex(
          /^[A-Z][A-Z0-9_]*$/,
          "Use an environment-variable name, not a secret value",
        ),
    ),
  })
  .superRefine((config, context) => {
    const targetKeys = Object.keys(config.targets)
      .filter((platform) => config.targets[platform as Platform] !== undefined)
      .sort();
    const toolKeys = Object.keys(config.tools)
      .filter((platform) => config.tools[platform as Platform] !== undefined)
      .sort();
    if (
      targetKeys.length !== toolKeys.length ||
      targetKeys.some((key, index) => key !== toolKeys[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Targets and tools must configure identical platform keys",
        path: ["tools"],
      });
    }
  });

export const projectConfigSchema = projectConfigV3Schema;

export type ProjectConfigV3 = z.infer<typeof projectConfigV3Schema>;
export type ProjectConfig = ProjectConfigV3;

export function configuredPlatforms(config: ProjectConfigV3): Platform[] {
  return platformSchema.options.filter(
    (platform) => config.targets[platform] !== undefined,
  );
}
