import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createTwoFilesPatch } from "diff";
import { satisfies } from "semver";
import { AiQaError } from "../../core/errors.js";
import { atomicWriteFile } from "../../core/fs/atomic-write.js";
import { WORK_PROTOCOL_VERSION } from "../../schemas/versions.js";
import { inspectManagedSkill, mergeManagedSkill } from "./managed-skill.js";

export interface SyncGlobalSkillInput {
  agentsHome: string;
  sourcePath: string;
  confirmManagedReplacement: boolean;
}

export interface GlobalSkillStatus {
  destination: string;
  changed: boolean;
  managedChecksum: string;
}

interface ReferenceAsset {
  relativePath: string;
  content: string;
  hash: string;
}

interface InstalledMetadata {
  aiQaSkillVersion: string;
  aiQaProtocolRange: string;
  aiQaRecordingReceipt: boolean;
}

function destinationFor(agentsHome: string): string {
  return join(agentsHome, "skills", "ai-qa", "SKILL.md");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }
  return files.sort();
}

async function readReferenceAssets(
  sourcePath: string,
): Promise<ReferenceAsset[]> {
  const referenceRoot = join(dirname(sourcePath), "references");
  const relativePaths = await listFiles(referenceRoot);
  return Promise.all(
    relativePaths.map(async (relativePath) => {
      const assetPath = join(referenceRoot, relativePath);
      const content = await readFile(assetPath, "utf8");
      return {
        relativePath,
        content,
        hash: sha256(content),
      };
    }),
  );
}

function referenceDestination(
  skillDestination: string,
  asset: ReferenceAsset,
): string {
  return join(dirname(skillDestination), "references", asset.relativePath);
}

function isManagedConflict(error: unknown): boolean {
  return error instanceof AiQaError && error.code === "skill.managed_conflict";
}

function parseInstalledMetadata(
  content: string,
  options: { allowMissingReceiptCapability?: boolean } = {},
): InstalledMetadata {
  const metadata = inspectManagedSkill(content).metadata;
  const aiQaSkillVersion = metadata.aiQaSkillVersion;
  const aiQaProtocolRange = metadata.aiQaProtocolRange;
  const aiQaRecordingReceipt = metadata.aiQaRecordingReceipt;
  if (
    typeof aiQaSkillVersion !== "string" ||
    typeof aiQaProtocolRange !== "string" ||
    (typeof aiQaRecordingReceipt !== "boolean" &&
      !(
        options.allowMissingReceiptCapability === true &&
        aiQaRecordingReceipt === undefined
      ))
  ) {
    throw new AiQaError(
      "skill.invalid_frontmatter",
      "SKILL.md compatibility metadata must include string versions and a boolean recording receipt capability",
    );
  }
  return {
    aiQaSkillVersion,
    aiQaProtocolRange,
    aiQaRecordingReceipt: aiQaRecordingReceipt ?? false,
  };
}

export async function previewGlobalSkillSync(input: {
  agentsHome: string;
  sourcePath: string;
}): Promise<{
  destination: string;
  changed: boolean;
  requiresConfirmation: boolean;
  unifiedDiff: string;
}> {
  const destination = destinationFor(input.agentsHome);
  const [source, existing, references] = await Promise.all([
    readFile(input.sourcePath, "utf8"),
    readOptional(destination),
    readReferenceAssets(input.sourcePath),
  ]);
  parseInstalledMetadata(source);

  let requiresConfirmation = false;
  if (existing !== undefined) {
    try {
      mergeManagedSkill({
        source,
        existing,
        confirmManagedReplacement: false,
      });
    } catch (error: unknown) {
      if (!isManagedConflict(error)) {
        throw error;
      }
      requiresConfirmation = true;
    }
  }
  const proposed = mergeManagedSkill({
    source,
    ...(existing === undefined ? {} : { existing }),
    confirmManagedReplacement: true,
  });
  const diffs: string[] = [];
  if (proposed.changed) {
    diffs.push(
      createTwoFilesPatch(
        destination,
        `${destination} (proposed)`,
        existing ?? "",
        proposed.content,
      ),
    );
  }

  let referencesChanged = false;
  for (const reference of references) {
    const installedPath = referenceDestination(destination, reference);
    const installed = await readOptional(installedPath);
    if (installed === undefined || sha256(installed) !== reference.hash) {
      referencesChanged = true;
      diffs.push(
        createTwoFilesPatch(
          installedPath,
          `${installedPath} (proposed)`,
          installed ?? "",
          reference.content,
        ),
      );
      if (installed !== undefined) {
        requiresConfirmation = true;
      }
    }
  }
  const sourceReferencePaths = new Set(
    references.map((reference) => reference.relativePath),
  );
  const installedReferenceRoot = join(dirname(destination), "references");
  const staleReferencePaths = (await listFiles(installedReferenceRoot)).filter(
    (relativePath) => !sourceReferencePaths.has(relativePath),
  );
  for (const relativePath of staleReferencePaths) {
    const installedPath = join(installedReferenceRoot, relativePath);
    const installed = await readFile(installedPath, "utf8");
    referencesChanged = true;
    requiresConfirmation = true;
    diffs.push(
      createTwoFilesPatch(
        installedPath,
        `${installedPath} (proposed)`,
        installed,
        "",
      ),
    );
  }

  return {
    destination,
    changed: proposed.changed || referencesChanged,
    requiresConfirmation,
    unifiedDiff: diffs.join("\n"),
  };
}

export async function syncGlobalSkill(
  input: SyncGlobalSkillInput,
): Promise<GlobalSkillStatus> {
  const destination = destinationFor(input.agentsHome);
  const [source, existing, references] = await Promise.all([
    readFile(input.sourcePath, "utf8"),
    readOptional(destination),
    readReferenceAssets(input.sourcePath),
  ]);
  parseInstalledMetadata(source);
  const merged = mergeManagedSkill({
    source,
    ...(existing === undefined ? {} : { existing }),
    confirmManagedReplacement: input.confirmManagedReplacement,
  });

  const referenceWrites: Array<{ path: string; content: string }> = [];
  for (const reference of references) {
    const installedPath = referenceDestination(destination, reference);
    const installed = await readOptional(installedPath);
    if (installed === undefined) {
      referenceWrites.push({ path: installedPath, content: reference.content });
      continue;
    }
    if (sha256(installed) !== reference.hash) {
      if (!input.confirmManagedReplacement) {
        throw new AiQaError(
          "skill.reference_conflict",
          "Installed CLI-managed skill reference differs from the bundled reference",
          {
            path: installedPath,
            installed: sha256(installed),
            proposed: reference.hash,
          },
        );
      }
      referenceWrites.push({ path: installedPath, content: reference.content });
    }
  }
  const sourceReferencePaths = new Set(
    references.map((reference) => reference.relativePath),
  );
  const installedReferenceRoot = join(dirname(destination), "references");
  const staleReferencePaths = (await listFiles(installedReferenceRoot)).filter(
    (relativePath) => !sourceReferencePaths.has(relativePath),
  );
  if (staleReferencePaths.length > 0 && !input.confirmManagedReplacement) {
    throw new AiQaError(
      "skill.reference_conflict",
      "Installed CLI-managed skill contains references retired from the bundled asset set",
      { paths: staleReferencePaths },
    );
  }

  await mkdir(dirname(destination), { recursive: true });
  if (merged.changed) {
    await atomicWriteFile(destination, merged.content);
  }
  await Promise.all(
    referenceWrites.map(({ path, content }) => atomicWriteFile(path, content)),
  );
  await Promise.all(
    staleReferencePaths.map((relativePath) =>
      unlink(join(installedReferenceRoot, relativePath)),
    ),
  );
  return {
    destination,
    changed:
      merged.changed ||
      referenceWrites.length > 0 ||
      staleReferencePaths.length > 0,
    managedChecksum: merged.managedChecksum,
  };
}

export async function checkGlobalSkill(input: {
  agentsHome: string;
  sourcePath: string;
}): Promise<{
  status: "compatible" | "missing" | "stale" | "conflict";
  destination: string;
}> {
  const destination = destinationFor(input.agentsHome);
  const existing = await readOptional(destination);
  if (existing === undefined) {
    return { status: "missing", destination };
  }
  const [source, references] = await Promise.all([
    readFile(input.sourcePath, "utf8"),
    readReferenceAssets(input.sourcePath),
  ]);

  let proposed;
  try {
    proposed = mergeManagedSkill({
      source,
      existing,
      confirmManagedReplacement: false,
    });
  } catch {
    return { status: "conflict", destination };
  }

  let sourceMetadata: InstalledMetadata;
  let installedMetadata: InstalledMetadata;
  try {
    sourceMetadata = parseInstalledMetadata(source);
    installedMetadata = parseInstalledMetadata(existing, {
      allowMissingReceiptCapability: true,
    });
  } catch {
    return { status: "conflict", destination };
  }
  if (
    sourceMetadata.aiQaSkillVersion !== installedMetadata.aiQaSkillVersion ||
    !installedMetadata.aiQaRecordingReceipt ||
    !satisfies(WORK_PROTOCOL_VERSION, installedMetadata.aiQaProtocolRange) ||
    proposed.changed
  ) {
    return { status: "stale", destination };
  }

  for (const reference of references) {
    const installed = await readOptional(
      referenceDestination(destination, reference),
    );
    if (installed === undefined) {
      return { status: "stale", destination };
    }
    if (sha256(installed) !== reference.hash) {
      return { status: "conflict", destination };
    }
  }
  const sourceReferencePaths = new Set(
    references.map((reference) => reference.relativePath),
  );
  const installedReferencePaths = await listFiles(
    join(dirname(destination), "references"),
  );
  if (
    installedReferencePaths.some(
      (relativePath) => !sourceReferencePaths.has(relativePath),
    )
  ) {
    return { status: "stale", destination };
  }
  return { status: "compatible", destination };
}
