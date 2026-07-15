import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { satisfies, validRange } from "semver";
import { z } from "zod";
import { AiQaError } from "../../core/errors.js";
import {
  inspectManagedSkill,
  mergeManagedSkill,
  type ManagedSkillInspection,
} from "./managed-skill.js";

const PROJECT_SKILL_NAME = "ai-qa-project";
const PROJECT_SKILL_VERSION = "1.0.0";
const PROJECT_SKILL_PROTOCOL_VERSION = "1.1.0";
const PROJECT_SKILL_RELATIVE_SEGMENTS = [
  ".agents",
  "skills",
  PROJECT_SKILL_NAME,
  "SKILL.md",
] as const;
const PROJECT_SKILL_RELATIVE_PATH = PROJECT_SKILL_RELATIVE_SEGMENTS.join("/");

export const projectSkillRequestSchema = z.object({
  reason: z.string().trim().min(1).max(4096),
  content: z.string().min(1).max(262144),
});

export interface PreparedProjectSkill {
  content: string;
  managedChecksum: string;
  changed: boolean;
  requiresManagedReplacement: boolean;
  unifiedDiff: string;
}

export type ProjectSkillStatus =
  | { status: "compatible"; destination: string }
  | { status: "missing"; destination: string }
  | { status: "conflict"; destination: string }
  | { status: "incompatible"; destination: string };

export interface PrepareProjectSkillInput {
  source: string;
  existing?: string;
  secretReferences: Readonly<Record<string, string>>;
}

export interface InspectProjectSkillInput {
  projectRoot: string;
  content?: string;
  secretReferences: Readonly<Record<string, string>>;
}

function invalidProjectSkill(message: string): never {
  throw new AiQaError("skill.invalid_project_skill", message);
}

function validateCompatibility(inspection: ManagedSkillInspection): boolean {
  const version = inspection.metadata.aiQaProjectSkillVersion;
  const protocolRange = inspection.metadata.aiQaProtocolRange;
  return (
    inspection.name === PROJECT_SKILL_NAME &&
    version === PROJECT_SKILL_VERSION &&
    typeof protocolRange === "string" &&
    validRange(protocolRange) !== null &&
    satisfies(PROJECT_SKILL_PROTOCOL_VERSION, protocolRange)
  );
}

const INSTRUCTION_VERBS = new Set([
  "archive",
  "click",
  "create",
  "delete",
  "enter",
  "execute",
  "install",
  "log",
  "navigate",
  "open",
  "read",
  "run",
  "save",
  "set",
  "start",
  "submit",
  "upload",
  "write",
]);

function containsInstructionInfinitive(value: string): boolean {
  for (const match of value.matchAll(/\bto\s+([a-z]+)\b/gi)) {
    const verb = match[1];
    if (verb !== undefined && INSTRUCTION_VERBS.has(verb.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function isTriggerContextList(value: string | undefined): boolean {
  if (value === undefined) return true;
  const items = value.split(",");
  return items.every((rawItem, index) => {
    const match =
      /^(?:(and|or)\s+)?([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*){0,2})$/i.exec(
        rawItem.trim(),
      );
    const connector = match?.[1];
    const context = match?.[2];
    if (
      context === undefined ||
      (connector !== undefined && index !== items.length - 1)
    ) {
      return false;
    }
    const firstWord = /^[a-z]+/i.exec(context)?.[0];
    return (
      firstWord !== undefined &&
      !INSTRUCTION_VERBS.has(firstWord.toLowerCase()) &&
      !/\b(?:and|or)\b/i.test(context) &&
      !/\b(?:please|must|should|then)\b/i.test(context)
    );
  });
}

function validateTriggerDescription(description: string): void {
  const prefix = "Use when ";
  if (!description.startsWith(prefix)) {
    invalidProjectSkill(
      "Project Skill description must begin with 'Use when '",
    );
  }
  const triggerContext = description.slice(prefix.length).replace(/\.$/, "");
  const sections = triggerContext.split(", including ");
  const primaryContext = sections[0];
  const hasInvalidStructure =
    primaryContext === undefined ||
    !/^[a-z]+ing\b/i.test(primaryContext) ||
    sections.length > 2 ||
    primaryContext.includes(",") ||
    !isTriggerContextList(sections[1]) ||
    /[;:\n!?]|\.\s/.test(triggerContext) ||
    /\b(?:and|or)\s+(?![a-z]+ing\b)[a-z]+/i.test(primaryContext);
  const hasInstructionSignal =
    /\b(?:please|must|should|then)\b/i.test(triggerContext) ||
    containsInstructionInfinitive(triggerContext);
  if (hasInvalidStructure || hasInstructionSignal) {
    invalidProjectSkill(
      "Project Skill description must describe triggering contexts, not command steps",
    );
  }
}

function validateBodySize(inspection: ManagedSkillInspection): void {
  const body = `${inspection.managed}${inspection.user}`;
  const lineCount = body.length === 0 ? 0 : body.split(/\r\n|\r|\n/).length;
  const wordCount = body.match(/\S+/g)?.length ?? 0;
  if (lineCount > 500 || wordCount > 5_000) {
    invalidProjectSkill(
      "Project Skill body must not exceed 500 lines or 5,000 words",
    );
  }
}

function unsupportedSecretReference(): never {
  throw new AiQaError(
    "skill.unsupported_secret_reference",
    "Project Skill contains an environment-variable expansion that cannot be safely matched to config.secretReferences",
  );
}

function parameterExpansionEnds(content: string): ReadonlyMap<number, number> {
  const starts: number[] = [];
  const ends = new Map<number, number>();
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "$" && content[index + 1] === "{") {
      starts.push(index);
      index += 1;
      continue;
    }
    if (content[index] !== "}" || starts.length === 0) continue;
    ends.set(starts.pop()!, index);
  }
  return ends;
}

function isUppercaseEnvironmentNameStart(value: string | undefined): boolean {
  return value !== undefined && /^[A-Z]$/.test(value);
}

function isUppercaseEnvironmentNameCharacter(
  value: string | undefined,
): boolean {
  return value !== undefined && /^[A-Z0-9_]$/.test(value);
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z_]$/.test(value);
}

function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9_]$/.test(value);
}

function identifierEnd(
  content: string,
  start: number,
  limit: number,
  isCharacter: (value: string | undefined) => boolean,
): number {
  let end = start;
  while (end < limit && isCharacter(content[end])) end += 1;
  return end;
}

function hasPowerShellEnvironmentPrefix(
  content: string,
  start: number,
): boolean {
  return content.slice(start, start + 4).toLowerCase() === "env:";
}

function bracedEnvironmentReferenceName(
  content: string,
  start: number,
  end: number,
): string | undefined {
  if (hasPowerShellEnvironmentPrefix(content, start)) {
    const nameStart = start + 4;
    if (!isIdentifierStart(content[nameStart])) unsupportedSecretReference();
    const nameEnd = identifierEnd(
      content,
      nameStart,
      end,
      isIdentifierCharacter,
    );
    if (nameEnd !== end) unsupportedSecretReference();
    return content.slice(nameStart, nameEnd);
  }

  let nameStart = start;
  if (content[nameStart] === "!" || content[nameStart] === "#") {
    nameStart += 1;
    if (isUppercaseEnvironmentNameStart(content[nameStart])) {
      unsupportedSecretReference();
    }
    return undefined;
  }
  if (!isUppercaseEnvironmentNameStart(content[nameStart])) return undefined;
  const nameEnd = identifierEnd(
    content,
    nameStart,
    end,
    isUppercaseEnvironmentNameCharacter,
  );
  if (nameEnd === end) return content.slice(nameStart, nameEnd);
  if (isIdentifierCharacter(content[nameEnd])) return undefined;

  const firstOperatorCharacter = content[nameEnd];
  const secondOperatorCharacter = content[nameEnd + 1];
  const hasPosixOperator =
    firstOperatorCharacter !== undefined &&
    ("-=?+".includes(firstOperatorCharacter) ||
      (firstOperatorCharacter === ":" &&
        secondOperatorCharacter !== undefined &&
        "-=?+".includes(secondOperatorCharacter)));
  if (!hasPosixOperator) unsupportedSecretReference();
  return content.slice(nameStart, nameEnd);
}

function environmentReferenceNames(content: string): string[] {
  const names: string[] = [];
  const expansionEnds = parameterExpansionEnds(content);
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "$") continue;

    if (content[index + 1] === "{") {
      const expressionStart = index + 2;
      const expressionEnd = expansionEnds.get(index);
      if (expressionEnd === undefined) {
        const name = bracedEnvironmentReferenceName(
          content,
          expressionStart,
          content.length,
        );
        if (name !== undefined) unsupportedSecretReference();
        continue;
      }
      const name = bracedEnvironmentReferenceName(
        content,
        expressionStart,
        expressionEnd,
      );
      if (name !== undefined) names.push(name);
      continue;
    }

    if (content.slice(index, index + 5).toLowerCase() === "$env:") {
      const nameStart = index + 5;
      if (!isIdentifierStart(content[nameStart])) unsupportedSecretReference();
      const nameEnd = identifierEnd(
        content,
        nameStart,
        content.length,
        isIdentifierCharacter,
      );
      names.push(content.slice(nameStart, nameEnd));
      continue;
    }

    const nameStart = index + 1;
    if (!isUppercaseEnvironmentNameStart(content[nameStart])) continue;
    const nameEnd = identifierEnd(
      content,
      nameStart,
      content.length,
      isUppercaseEnvironmentNameCharacter,
    );
    if (isIdentifierCharacter(content[nameEnd])) continue;
    names.push(content.slice(nameStart, nameEnd));
  }
  return names;
}

function exactEnvironmentReferenceName(value: string): string | undefined {
  const posix = /^\$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))$/.exec(value);
  const posixName = posix?.[1] ?? posix?.[2];
  if (posixName !== undefined) return posixName;

  const powershell =
    /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/i.exec(value) ??
    /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/i.exec(value);
  return powershell?.[1];
}

function validateSecrets(
  content: string,
  secretReferences: Readonly<Record<string, string>>,
): void {
  const allowedEnvironmentNames = new Set(Object.values(secretReferences));
  for (const environmentName of environmentReferenceNames(content)) {
    if (!allowedEnvironmentNames.has(environmentName)) {
      throw new AiQaError(
        "skill.unknown_secret_reference",
        "Project Skill refers to an environment variable not declared by config.secretReferences",
        { environmentName },
      );
    }
  }

  if (
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(content) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/i.test(content) ||
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(content)
  ) {
    throw new AiQaError(
      "skill.literal_secret",
      "Project Skill contains a possible literal secret",
    );
  }

  const secretAssignment =
    /\b(?:password|passwd|pwd|secret|token|api[-_ ]?key|credentials?)\b\s*[:=]\s*(.+?)\s*$/i;
  for (const line of content.split(/\r\n|\r|\n/)) {
    const assignment = secretAssignment.exec(line);
    if (assignment?.[1] === undefined) continue;
    const environmentName = exactEnvironmentReferenceName(assignment[1]);
    if (
      environmentName === undefined ||
      !allowedEnvironmentNames.has(environmentName)
    ) {
      throw new AiQaError(
        "skill.literal_secret",
        "Secret assignments must use a configured environment-variable reference",
      );
    }
  }
}

function validateSource(
  source: string,
  secretReferences: Readonly<Record<string, string>>,
): ManagedSkillInspection {
  const inspection = inspectManagedSkill(source);
  if (!validateCompatibility(inspection)) {
    invalidProjectSkill(
      "Project Skill requires the fixed name, version 1.0.0, and a protocol range containing 1.1.0",
    );
  }
  validateTriggerDescription(inspection.description);
  validateBodySize(inspection);
  validateSecrets(source, secretReferences);
  return inspection;
}

function isManagedConflict(error: unknown): boolean {
  return error instanceof AiQaError && error.code === "skill.managed_conflict";
}

export function prepareProjectSkill(
  input: PrepareProjectSkillInput,
): PreparedProjectSkill {
  validateSource(input.source, input.secretReferences);
  let requiresManagedReplacement = false;
  if (input.existing !== undefined) {
    try {
      mergeManagedSkill({
        source: input.source,
        existing: input.existing,
        confirmManagedReplacement: false,
      });
    } catch (error: unknown) {
      if (!isManagedConflict(error)) throw error;
      requiresManagedReplacement = true;
    }
  }
  const merged = mergeManagedSkill({
    source: input.source,
    ...(input.existing === undefined ? {} : { existing: input.existing }),
    confirmManagedReplacement: true,
  });
  validateSecrets(merged.content, input.secretReferences);
  return {
    ...merged,
    requiresManagedReplacement,
    unifiedDiff: merged.changed
      ? createTwoFilesPatch(
          PROJECT_SKILL_RELATIVE_PATH,
          `${PROJECT_SKILL_RELATIVE_PATH} (proposed)`,
          input.existing ?? "",
          merged.content,
        )
      : "",
  };
}

export function inspectProjectSkill(
  input: InspectProjectSkillInput,
): ProjectSkillStatus {
  const destination = projectSkillDestination(input.projectRoot);
  if (input.content === undefined) return { status: "missing", destination };
  let inspection: ManagedSkillInspection;
  try {
    inspection = inspectManagedSkill(input.content);
  } catch {
    return { status: "conflict", destination };
  }
  if (!validateCompatibility(inspection)) {
    return { status: "incompatible", destination };
  }
  try {
    validateTriggerDescription(inspection.description);
    validateBodySize(inspection);
  } catch {
    return { status: "incompatible", destination };
  }
  if (inspection.recordedManagedChecksum !== inspection.managedChecksum) {
    return { status: "conflict", destination };
  }
  try {
    validateSecrets(input.content, input.secretReferences);
  } catch {
    return { status: "incompatible", destination };
  }
  return { status: "compatible", destination };
}

export function projectSkillDestination(projectRoot: string): string {
  return join(projectRoot, ...PROJECT_SKILL_RELATIVE_SEGMENTS);
}
