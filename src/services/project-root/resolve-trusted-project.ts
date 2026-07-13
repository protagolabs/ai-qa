import { AiQaError } from "../../core/errors.js";
import { readRepositoryIdentity } from "../trust/repository-identity.js";
import { TrustStore } from "../trust/trust-store.js";
import { resolveProjectRoot } from "./resolve-project-root.js";

export async function resolveTrustedProject(input: {
  cwd: string;
  explicitProject?: string;
  aiQaHome: string;
}): Promise<{ projectRoot: string }> {
  const resolved = await resolveProjectRoot({
    command: "other",
    cwd: input.cwd,
    ...(input.explicitProject === undefined
      ? {}
      : { explicitProject: input.explicitProject }),
  });
  const identity = await readRepositoryIdentity(resolved.root);
  if (!(await new TrustStore(input.aiQaHome).isTrusted(identity))) {
    throw new AiQaError(
      "trust.not_trusted",
      "Trust this repository before loading project data",
    );
  }
  return { projectRoot: resolved.root };
}
