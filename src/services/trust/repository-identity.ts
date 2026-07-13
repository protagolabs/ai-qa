import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepositoryIdentity {
  canonicalPath: string;
  fingerprint: string;
  remoteUrl?: string;
}

export async function readRepositoryIdentity(
  projectRoot: string,
): Promise<RepositoryIdentity> {
  const canonicalPath = await realpath(projectRoot);
  let remoteUrl: string | undefined;
  try {
    const result = await execFileAsync("git", [
      "-C",
      canonicalPath,
      "config",
      "--get",
      "remote.origin.url",
    ]);
    const value = result.stdout.trim();
    if (value.length > 0) remoteUrl = value;
  } catch {
    remoteUrl = undefined;
  }
  const identitySource =
    remoteUrl === undefined ? canonicalPath : `${canonicalPath}\n${remoteUrl}`;
  return {
    canonicalPath,
    fingerprint: createHash("sha256").update(identitySource).digest("hex"),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
  };
}
