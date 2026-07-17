import { isAbsolute, relative, resolve, sep } from "node:path";
import { AiQaError } from "../errors.js";
import { runGroupIdSchema } from "./schema.js";

export interface RunGroupPaths {
  root: string;
  directory: string;
  manifest: string;
  events: string;
}

function requireStrictDescendant(root: string, candidate: string): string {
  const child = relative(root, candidate);
  if (
    child.length === 0 ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new AiQaError(
      "run_group.invalid_id",
      "Run-group ID must stay inside the run-groups root",
    );
  }
  return candidate;
}

export function resolveRunGroupPaths(
  projectRoot: string,
  runGroupId: string,
): RunGroupPaths {
  const validatedId = runGroupIdSchema.parse(runGroupId);
  const root = resolve(projectRoot, ".ai-qa", "run-groups");
  const directory = requireStrictDescendant(
    root,
    resolve(root, validatedId),
  );
  return {
    root,
    directory,
    manifest: requireStrictDescendant(root, resolve(directory, "group.json")),
    events: requireStrictDescendant(root, resolve(directory, "events.jsonl")),
  };
}
