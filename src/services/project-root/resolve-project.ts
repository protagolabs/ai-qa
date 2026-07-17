import { resolveProjectRoot } from "./resolve-project-root.js";

export async function resolveProject(input: {
  cwd: string;
  explicitProject?: string;
}): Promise<{ projectRoot: string }> {
  const resolved = await resolveProjectRoot({
    command: "other",
    cwd: input.cwd,
    ...(input.explicitProject === undefined
      ? {}
      : { explicitProject: input.explicitProject }),
  });
  return { projectRoot: resolved.root };
}
