import { AiQaError } from "../../core/errors.js";
import { readRepositoryIdentity } from "./repository-identity.js";
import { TrustStore } from "./trust-store.js";

export async function confirmProjectTrust(input: {
  projectRoot: string;
  aiQaHome: string;
  confirmed: boolean;
  now: Date;
}): Promise<{
  canonicalPath: string;
  fingerprint: string;
  confirmedAt: string;
}> {
  if (!input.confirmed) {
    throw new AiQaError(
      "trust.confirmation_required",
      "Explicit user confirmation is required",
    );
  }
  const identity = await readRepositoryIdentity(input.projectRoot);
  await new TrustStore(input.aiQaHome).trust(identity, input.now);
  return {
    canonicalPath: identity.canonicalPath,
    fingerprint: identity.fingerprint,
    confirmedAt: input.now.toISOString(),
  };
}
