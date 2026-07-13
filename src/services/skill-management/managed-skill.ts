import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { AiQaError } from "../../core/errors.js";

const MANAGED_START = "<!-- ai-qa:managed:start -->";
const MANAGED_END = "<!-- ai-qa:managed:end -->";
const USER_START = "<!-- ai-qa:user:start -->";
const USER_END = "<!-- ai-qa:user:end -->";

const skillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    description: z.string().min(1).max(1024),
    metadata: z
      .object({
        aiQaSkillVersion: z.string(),
        aiQaProtocolRange: z.string(),
        aiQaManagedChecksum: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

interface SkillParts {
  frontmatter: Record<string, unknown>;
  managed: string;
  user: string;
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

function between(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new AiQaError(
      "skill.invalid_markers",
      `Missing or misordered ${start} and ${end}`,
    );
  }
  return content.slice(startIndex + start.length, endIndex);
}

function parseSkill(content: string): SkillParts {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (match?.[1] === undefined) {
    throw new AiQaError(
      "skill.invalid_frontmatter",
      "SKILL.md requires YAML frontmatter",
    );
  }
  return {
    frontmatter: skillFrontmatterSchema.parse(parse(match[1])) as Record<
      string,
      unknown
    >,
    managed: between(content, MANAGED_START, MANAGED_END),
    user: between(content, USER_START, USER_END),
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
  const managedChecksum = checksum(source.frontmatter, source.managed);
  let existing: SkillParts | undefined;
  if (input.existing !== undefined) {
    existing = parseSkill(input.existing);
    const metadata =
      (existing.frontmatter.metadata as Record<string, unknown>) ?? {};
    const recorded = metadata.aiQaManagedChecksum;
    const actual = checksum(existing.frontmatter, existing.managed);
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
  const content = `---\n${frontmatter}\n---\n${MANAGED_START}${source.managed}${MANAGED_END}\n${USER_START}${user}${USER_END}\n`;
  return {
    content,
    managedChecksum,
    changed: content !== input.existing,
  };
}
