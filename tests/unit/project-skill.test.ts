import { describe, expect, it } from "vitest";
import {
  inspectProjectSkill,
  prepareProjectSkill,
  projectSkillDestination,
  projectSkillRequestSchema,
} from "../../src/services/skill-management/project-skill.js";
import { mergeManagedSkill } from "../../src/services/skill-management/managed-skill.js";

export function projectSkillSource(
  recordingProcedure: string = "No additional project record is required; the verified local report completes the workflow.",
): string {
  return `---
name: ai-qa-project
description: Use when performing AI QA work in this target project, including startup, authentication, evidence, reports, or result recording.
metadata:
  aiQaProjectSkillVersion: 1.0.0
  aiQaProtocolRange: ^1.1.0
  aiQaManagedChecksum: generated
---
<!-- ai-qa:managed:start -->
# Project AI QA Procedures

## Startup and environment

Run the existing local development command documented by the project.

## Authentication and test data

Read credentials only from \${QA_TEST_PASSWORD}; never persist the value.

## Navigation and platform constraints

Start at the configured Web entry URL and prefer stable test IDs.

## Evidence, privacy, and reports

Follow config sensitivity, retention, and local report policy.

## Project result recording

${recordingProcedure}
<!-- ai-qa:managed:end -->
<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
`;
}

const secretReferences = { login: "QA_TEST_PASSWORD" };

function prepare(source: string = projectSkillSource(), existing?: string) {
  return prepareProjectSkill({
    source,
    ...(existing === undefined ? {} : { existing }),
    secretReferences,
  });
}

describe("project Skill validation", () => {
  it("accepts only the fixed project Skill name", () => {
    expect(() => prepare()).not.toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace("name: ai-qa-project", "name: local-qa"),
      ),
    ).toThrow();
  });

  it("requires project Skill version 1.0.0 and a protocol range containing 1.1.0", () => {
    expect(() =>
      prepare(
        projectSkillSource().replace(
          "aiQaProjectSkillVersion: 1.0.0",
          "aiQaProjectSkillVersion: 2.0.0",
        ),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          "aiQaProtocolRange: ^1.1.0",
          "aiQaProtocolRange: ~1.0.0",
        ),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          "aiQaProtocolRange: ^1.1.0",
          "aiQaProtocolRange: definitely-not-semver",
        ),
      ),
    ).toThrow();
  });

  it("requires exactly one ordered managed and user marker pair", () => {
    expect(() =>
      prepare(
        projectSkillSource().replace(
          "<!-- ai-qa:user:end -->",
          "<!-- ai-qa:user:end -->\n<!-- ai-qa:user:end -->",
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "skill.invalid_markers" }));

    const markerInFrontmatter = projectSkillSource()
      .replace(
        /^description: .+$/m,
        (description) => `${description} <!-- ai-qa:managed:start -->`,
      )
      .replace(
        "\n<!-- ai-qa:managed:start -->\n# Project AI QA Procedures",
        "\n# Project AI QA Procedures",
      );
    expect(() => prepare(markerInFrontmatter)).toThrowError(
      expect.objectContaining({ code: "skill.invalid_markers" }),
    );
    expect(() =>
      prepare(
        projectSkillSource().replace(
          "<!-- ai-qa:managed:end -->\n<!-- ai-qa:user:start -->",
          "<!-- ai-qa:user:start -->\n<!-- ai-qa:managed:end -->",
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "skill.invalid_markers" }));
  });

  it("preserves an installed CRLF user region byte-for-byte", () => {
    const installed = prepare(
      projectSkillSource("Use the previous local recording procedure."),
    ).content.replace(/\n/g, "\r\n");
    const userRegion = "\r\nLocal Windows note  \r\nSecond line\t\r\n";
    const existing = installed.replace(
      "<!-- ai-qa:user:start -->\r\n<!-- ai-qa:user:end -->",
      `<!-- ai-qa:user:start -->${userRegion}<!-- ai-qa:user:end -->`,
    );

    const result = prepare(projectSkillSource(), existing);

    expect(result.changed).toBe(true);
    expect(result.content).toContain(
      `<!-- ai-qa:user:start -->${userRegion}<!-- ai-qa:user:end -->`,
    );
  });

  it("prepares a confirmed replacement and diff when installed managed content was edited", () => {
    const installed = prepare().content;
    const existing = installed.replace(
      "Run the existing local development command",
      "Run a locally edited development command",
    );

    const result = prepare(projectSkillSource(), existing);

    expect(result.requiresManagedReplacement).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.unifiedDiff).toContain(
      "-Run a locally edited development command",
    );
    expect(result.unifiedDiff).toContain(
      "+Run the existing local development command",
    );
  });

  it.each([
    "password: literal-value",
    "Open https://qa-user:literal-password@example.test/admin.",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345==",
    "-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END ENCRYPTED PRIVATE KEY-----",
  ])("rejects high-confidence literal secret signal %s", (procedure) => {
    expect(() => prepare(projectSkillSource(procedure))).toThrow();
  });

  it("accepts configured environment references and rejects unknown ones", () => {
    expect(() =>
      prepare(projectSkillSource("password: ${QA_TEST_PASSWORD}")),
    ).not.toThrow();
    expect(() =>
      prepare(projectSkillSource("password: ${UNKNOWN_PASSWORD}")),
    ).toThrow();
    expect(() =>
      prepare(projectSkillSource("password: $QA_TEST_PASSWORD")),
    ).not.toThrow();
    expect(() =>
      prepare(
        projectSkillSource("Read the password only from $UNDECLARED_PASSWORD."),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource(
          "The disposable test-data budget is $25.00 USD per run.",
        ),
      ),
    ).not.toThrow();
  });

  it("accepts an arbitrary local Markdown-table recording procedure without a provider", () => {
    const procedure = `| Result | Project action |
| --- | --- |
| Pass | Add a row to the team's local QA ledger |
| Fail | Open the project's incident template |`;

    const result = prepare(projectSkillSource(procedure));

    expect(result.content).toContain("team's local QA ledger");
    expect(result.content).not.toMatch(/provider:/i);
  });

  it("requires a trigger-only Use when description within the frontmatter limit", () => {
    expect(() =>
      prepare(
        projectSkillSource().replace(
          /^description: .+$/m,
          "description: Use when investigating target-project QA failures or recording verified results.",
        ),
      ),
    ).not.toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          /^description: .+$/m,
          "description: Use when responding to project QA failures.",
        ),
      ),
    ).not.toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          /^description: .+$/m,
          "description: Run the project's QA commands.",
        ),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          /^description: .+$/m,
          "description: Use when doing project QA, archive the results.",
        ),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          /^description: .+$/m,
          "description: Use when performing project QA to run the suite.",
        ),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          /^description: .+$/m,
          "description: Use when performing project QA. Please upload the results.",
        ),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          /^description: .+$/m,
          "description: Use when doing project QA, run pnpm test and save the output.",
        ),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          /^description: .+$/m,
          "description: Use when doing project QA and execute the suite.",
        ),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          /^description: .+$/m,
          "description: Use when doing project QA. Run pnpm test and save the output.",
        ),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource().replace(
          /^description: .+$/m,
          `description: Use when ${"x".repeat(1024)}`,
        ),
      ),
    ).toThrow();
  });

  it("rejects generated bodies over 500 lines or 5,000 words", () => {
    expect(() =>
      prepare(
        projectSkillSource(
          Array.from({ length: 501 }, () => "line").join("\n"),
        ),
      ),
    ).toThrow();
    expect(() =>
      prepare(
        projectSkillSource(
          Array.from({ length: 5_001 }, () => "word").join(" "),
        ),
      ),
    ).toThrow();
  });
});

describe("project Skill public interfaces", () => {
  it("validates project Skill requests", () => {
    expect(
      projectSkillRequestSchema.parse({
        reason: "  Project-specific QA workflow  ",
        content: projectSkillSource(),
      }),
    ).toMatchObject({ reason: "Project-specific QA workflow" });
    expect(() =>
      projectSkillRequestSchema.parse({ reason: " ", content: "x" }),
    ).toThrow();
  });

  it("reports missing, compatible, conflicting, and incompatible installed states", () => {
    const projectRoot = "/work/project";
    const destination = "/work/project/.agents/skills/ai-qa-project/SKILL.md";
    expect(projectSkillDestination(projectRoot)).toBe(destination);
    expect(inspectProjectSkill({ projectRoot })).toEqual({
      status: "missing",
      destination,
    });

    const installed = prepare().content;
    expect(inspectProjectSkill({ projectRoot, content: installed })).toEqual({
      status: "compatible",
      destination,
    });
    expect(
      inspectProjectSkill({
        projectRoot,
        content: installed.replace(
          "# Project AI QA Procedures",
          "# Local edit",
        ),
      }),
    ).toEqual({ status: "conflict", destination });
    expect(
      inspectProjectSkill({
        projectRoot,
        content: installed.replace(
          "aiQaProjectSkillVersion: 1.0.0",
          "aiQaProjectSkillVersion: 2.0.0",
        ),
      }),
    ).toEqual({ status: "incompatible", destination });

    const invalidDescription = mergeManagedSkill({
      source: projectSkillSource().replace(
        /^description: .+$/m,
        "description: Project QA procedures",
      ),
      confirmManagedReplacement: false,
    });
    expect(
      inspectProjectSkill({
        projectRoot,
        content: invalidDescription.content,
      }),
    ).toEqual({ status: "incompatible", destination });
  });
});
