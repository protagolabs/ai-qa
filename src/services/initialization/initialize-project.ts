import { AiQaError } from "../../core/errors.js";
import { readRepositoryIdentity } from "../trust/repository-identity.js";
import { TrustStore } from "../trust/trust-store.js";
import {
  applyProjectSetup as applyUntrustedProjectSetup,
  previewProjectSetup as previewUntrustedProjectSetup,
  type ApplyProjectSetupInput,
  type PreviewProjectSetupInput,
  type ProjectSetupPreview,
} from "./project-setup.js";

export interface TrustedPreviewProjectSetupInput extends PreviewProjectSetupInput {
  aiQaHome: string;
}

export interface TrustedApplyProjectSetupInput extends ApplyProjectSetupInput {
  aiQaHome: string;
}

async function verifyProjectTrust(input: {
  projectRoot: string;
  aiQaHome: string;
}): Promise<void> {
  const identity = await readRepositoryIdentity(input.projectRoot);
  if (!(await new TrustStore(input.aiQaHome).isTrusted(identity))) {
    throw new AiQaError(
      "trust.not_trusted",
      "Confirm repository trust before project setup",
    );
  }
}

export async function previewProjectSetup(
  input: TrustedPreviewProjectSetupInput,
): Promise<ProjectSetupPreview> {
  await verifyProjectTrust(input);
  return previewUntrustedProjectSetup(input);
}

export async function applyProjectSetup(
  input: TrustedApplyProjectSetupInput,
): Promise<ProjectSetupPreview> {
  await verifyProjectTrust(input);
  return applyUntrustedProjectSetup(input);
}
