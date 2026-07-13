import { isAbsolute, relative, resolve, sep } from "node:path";
import { AiQaError } from "../errors.js";
import { runIdSchema } from "./schema.js";

export interface RunPaths {
  runsRoot: string;
  directory: string;
  workOrder: string;
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
      "run.invalid_id",
      "Run ID must stay inside the runs root",
    );
  }
  return candidate;
}

export function resolveRunPaths(projectRoot: string, runId: string): RunPaths {
  const validatedRunId = runIdSchema.parse(runId);
  const runsRoot = resolve(projectRoot, ".ai-qa", "runs");
  const directory = requireStrictDescendant(
    runsRoot,
    resolve(runsRoot, validatedRunId),
  );
  return {
    runsRoot,
    directory,
    workOrder: requireStrictDescendant(
      runsRoot,
      resolve(directory, "work-order.json"),
    ),
    events: requireStrictDescendant(
      runsRoot,
      resolve(directory, "events.jsonl"),
    ),
  };
}
