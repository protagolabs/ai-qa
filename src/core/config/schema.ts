import { z } from "zod";

export const projectConfigSchema = z.object({
  schemaVersion: z.literal(1),
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
    web: z.object({ controller: z.literal("chrome-devtools-mcp") }),
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

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
