import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AiQaError } from "../../core/errors.js";
import { isNodeError } from "../../core/node-errors.js";

export interface ResolveProjectRootInput {
  command: "init" | "clear" | "other";
  cwd: string;
  explicitProject?: string;
}

export interface ResolvedProjectRoot {
  root: string;
  source: "explicit" | "config-ancestor" | "git-root";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

async function canonical(path: string): Promise<string> {
  return realpath(isAbsolute(path) ? path : resolve(path));
}

async function findAncestor(
  start: string,
  predicate: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  let current = await canonical(start);
  for (;;) {
    if (await predicate(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function resolveProjectRoot(
  input: ResolveProjectRootInput,
): Promise<ResolvedProjectRoot> {
  if (input.explicitProject !== undefined) {
    return {
      root: await canonical(resolve(input.cwd, input.explicitProject)),
      source: "explicit",
    };
  }
  const configRoot = await findAncestor(input.cwd, (candidate) =>
    exists(join(candidate, ".ai-qa", "config.yaml")),
  );
  if (configRoot !== undefined) {
    return { root: configRoot, source: "config-ancestor" };
  }
  if (input.command !== "other") {
    const gitRoot = await findAncestor(input.cwd, (candidate) =>
      exists(join(candidate, ".git")),
    );
    if (gitRoot !== undefined) return { root: gitRoot, source: "git-root" };
    throw new AiQaError(
      "project.explicit_required",
      `${input.command} outside Git requires --project <path>`,
    );
  }
  throw new AiQaError("project.not_found", "No .ai-qa/config.yaml found");
}
