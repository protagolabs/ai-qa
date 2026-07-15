import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { AiQaError } from "../../core/errors.js";

const MANAGED_START = "<!-- ai-qa:managed:start -->";
const MANAGED_END = "<!-- ai-qa:managed:end -->";
const USER_START = "<!-- ai-qa:user:start -->";
const USER_END = "<!-- ai-qa:user:end -->";
const MARKERS = [MANAGED_START, MANAGED_END, USER_START, USER_END] as const;

const skillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    description: z.string().min(1).max(1024),
    metadata: z
      .record(z.string(), z.unknown())
      .refine(
        (metadata) =>
          Object.prototype.hasOwnProperty.call(metadata, "aiQaManagedChecksum"),
        "SKILL.md metadata requires aiQaManagedChecksum",
      ),
  })
  .passthrough();

interface SkillParts extends ManagedSkillInspection {
  frontmatter: Record<string, unknown>;
}

interface MarkerPositions {
  managedStart: number;
  managedEnd: number;
  userStart: number;
  userEnd: number;
}

export interface MergeManagedSkillInput {
  source: string;
  existing?: string;
  confirmManagedReplacement: boolean;
}

export interface MergeManagedSkillResult {
  content: string;
  managedChecksum: string;
  changed: boolean;
}

export interface ManagedSkillInspection {
  name: string;
  description: string;
  metadata: Readonly<Record<string, unknown>>;
  managed: string;
  user: string;
  managedChecksum: string;
  recordedManagedChecksum: unknown;
}

function markerPositions(content: string): MarkerPositions {
  const positions = MARKERS.map((marker) => {
    const position = content.indexOf(marker);
    if (
      position < 0 ||
      content.indexOf(marker, position + marker.length) !== -1
    ) {
      throw new AiQaError(
        "skill.invalid_markers",
        "SKILL.md requires each managed and user marker exactly once in order",
      );
    }
    return position;
  });
  const [managedStart, managedEnd, userStart, userEnd] = positions;
  if (
    managedStart === undefined ||
    managedEnd === undefined ||
    userStart === undefined ||
    userEnd === undefined ||
    managedStart >= managedEnd ||
    managedEnd >= userStart ||
    userStart >= userEnd
  ) {
    throw new AiQaError(
      "skill.invalid_markers",
      "SKILL.md requires each managed and user marker exactly once in order",
    );
  }
  return { managedStart, managedEnd, userStart, userEnd };
}

function parseSkill(content: string): SkillParts {
  const positions = markerPositions(content);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (match?.[1] === undefined) {
    throw new AiQaError(
      "skill.invalid_frontmatter",
      "SKILL.md requires YAML frontmatter",
    );
  }
  if (positions.managedStart < match[0].length) {
    throw new AiQaError(
      "skill.invalid_markers",
      "SKILL.md managed and user markers must occur after frontmatter",
    );
  }
  let parsed: unknown;
  try {
    parsed = parse(match[1]);
  } catch {
    throw new AiQaError(
      "skill.invalid_frontmatter",
      "SKILL.md requires valid YAML frontmatter",
    );
  }
  const result = skillFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    throw new AiQaError(
      "skill.invalid_frontmatter",
      "SKILL.md requires a valid name, description, and managed metadata",
      { issues: result.error.issues },
    );
  }
  const frontmatter = result.data as Record<string, unknown>;
  const managed = content.slice(
    positions.managedStart + MANAGED_START.length,
    positions.managedEnd,
  );
  const user = content.slice(
    positions.userStart + USER_START.length,
    positions.userEnd,
  );
  const metadata = Object.freeze({
    ...(frontmatter.metadata as Record<string, unknown>),
  });
  const managedChecksum = checksum(frontmatter, managed);
  return {
    frontmatter,
    name: result.data.name,
    description: result.data.description,
    metadata,
    managed,
    user,
    managedChecksum,
    recordedManagedChecksum: metadata.aiQaManagedChecksum,
  };
}

function checksum(
  frontmatter: Record<string, unknown>,
  managed: string,
): string {
  const metadata = {
    ...((frontmatter.metadata as Record<string, unknown>) ?? {}),
  };
  delete metadata.aiQaManagedChecksum;
  const normalized = stringify(
    { ...frontmatter, metadata },
    { sortMapEntries: true },
  );
  return createHash("sha256")
    .update(`${normalized}\n${managed.replace(/\r\n/g, "\n")}`)
    .digest("hex");
}

export function mergeManagedSkill(
  input: MergeManagedSkillInput,
): MergeManagedSkillResult {
  const source = parseSkill(input.source);
  const managedChecksum = source.managedChecksum;
  let existing: SkillParts | undefined;
  if (input.existing !== undefined) {
    existing = parseSkill(input.existing);
    const recorded = existing.recordedManagedChecksum;
    const actual = existing.managedChecksum;
    if (recorded !== actual && !input.confirmManagedReplacement) {
      throw new AiQaError(
        "skill.managed_conflict",
        "Installed managed region was edited",
        {
          recorded,
          actual,
          proposed: managedChecksum,
        },
      );
    }
  }
  const metadata = {
    ...((source.frontmatter.metadata as Record<string, unknown>) ?? {}),
  };
  metadata.aiQaManagedChecksum = managedChecksum;
  const frontmatter = stringify(
    { ...source.frontmatter, metadata },
    { sortMapEntries: true },
  ).trimEnd();
  const user = existing?.user ?? source.user;
  const proposedContent = `---\n${frontmatter}\n---\n${MANAGED_START}${source.managed}${MANAGED_END}\n${USER_START}${user}${USER_END}\n`;
  const changed =
    input.existing === undefined ||
    proposedContent.replace(/\r\n/g, "\n") !==
      input.existing.replace(/\r\n/g, "\n");
  const content =
    !changed && input.existing !== undefined ? input.existing : proposedContent;
  return {
    content,
    managedChecksum,
    changed,
  };
}

export function inspectManagedSkill(content: string): ManagedSkillInspection {
  const inspection = parseSkill(content);
  return Object.freeze({
    name: inspection.name,
    description: inspection.description,
    metadata: inspection.metadata,
    managed: inspection.managed,
    user: inspection.user,
    managedChecksum: inspection.managedChecksum,
    recordedManagedChecksum: inspection.recordedManagedChecksum,
  });
}
