import { z } from "zod";
import { webControllerSchema } from "../tools.js";

const projectConfigFields = z.object({
  project: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    name: z.string().min(1),
  }),
  targets: z.object({
    web: z.object({
      entryUrl: z.string().url(),
      readinessUrl: z.string().url().optional(),
    }),
  }),
  environments: z.record(z.string(), z.unknown()),
  tools: z.object({
    web: z.object({ controller: webControllerSchema }),
  }),
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
});

export const recordingModeSchema = z.enum(["local-only", "project-skill"]);

export const projectConfigV1Schema = projectConfigFields.extend({
  schemaVersion: z.literal(1),
});

export const projectConfigV2Schema = projectConfigFields.extend({
  schemaVersion: z.literal(2),
  recordingPolicy: z.object({ mode: recordingModeSchema }),
});

export const storedProjectConfigSchema = z.discriminatedUnion("schemaVersion", [
  projectConfigV1Schema,
  projectConfigV2Schema,
]);

export const projectConfigSchema = projectConfigV2Schema;

export type ProjectConfigV1 = z.infer<typeof projectConfigV1Schema>;
export type ProjectConfigV2 = z.infer<typeof projectConfigV2Schema>;
export type StoredProjectConfig = z.infer<typeof storedProjectConfigSchema>;
export type EffectiveProjectConfig = ProjectConfigV2;
export type ProjectConfig = ProjectConfigV2;

export function normalizeProjectConfig(
  config: StoredProjectConfig,
): EffectiveProjectConfig {
  if (config.schemaVersion === 2) return config;
  const { schemaVersion, ...fields } = config;
  void schemaVersion;
  return projectConfigV2Schema.parse({
    ...fields,
    schemaVersion: 2,
    recordingPolicy: { mode: "local-only" },
  });
}
