import { describe, expect, it } from "vitest";
import {
  inspectManagedSkill,
  mergeManagedSkill,
} from "../../src/services/skill-management/managed-skill.js";

const source = `---
name: ai-qa
description: Canonical AI QA workflow
metadata:
  aiQaSkillVersion: 2.0.0
  aiQaProtocolRange: ^2.0.0
  aiQaManagedChecksum: bundled
---
<!-- ai-qa:managed:start -->
Canonical workflow
<!-- ai-qa:managed:end -->
<!-- ai-qa:user:start -->
<!-- ai-qa:user:end -->
`;

describe("mergeManagedSkill", () => {
  it("exposes an immutable provider-neutral inspection", () => {
    const projectSource = source
      .replace("name: ai-qa", "name: ai-qa-project")
      .replace("aiQaSkillVersion", "aiQaProjectSkillVersion");

    const inspection = inspectManagedSkill(projectSource);

    expect(inspection).toMatchObject({
      name: "ai-qa-project",
      description: "Canonical AI QA workflow",
      recordedManagedChecksum: "bundled",
    });
    expect(inspection.metadata).toMatchObject({
      aiQaProjectSkillVersion: "2.0.0",
    });
    expect(inspection.managedChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.metadata)).toBe(true);
  });

  it("preserves the existing user region byte-for-byte", () => {
    const existing = source.replace(
      "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
      "<!-- ai-qa:user:start -->\nMy local note  \n<!-- ai-qa:user:end -->",
    );

    const result = mergeManagedSkill({
      source,
      existing,
      confirmManagedReplacement: true,
    });

    expect(result.content).toContain(
      "My local note  \n<!-- ai-qa:user:end -->",
    );
    expect(result.content).not.toContain("aiQaManagedChecksum: bundled");
  });

  it("requires confirmation when the installed managed region was edited", () => {
    const existing = source.replace(
      "Canonical workflow",
      "Locally edited workflow",
    );

    expect(() =>
      mergeManagedSkill({
        source,
        existing,
        confirmManagedReplacement: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "skill.managed_conflict" }));
  });

  it("rejects a duplicate marker embedded in user content", () => {
    const existing = source.replace(
      "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
      "<!-- ai-qa:user:start -->\nLocal note mentions <!-- ai-qa:user:end -->\n<!-- ai-qa:user:end -->",
    );

    expect(() =>
      mergeManagedSkill({
        source,
        existing,
        confirmManagedReplacement: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "skill.invalid_markers" }));
  });

  it("rejects managed and user markers that are out of order", () => {
    const existing = source.replace(
      "<!-- ai-qa:managed:end -->\n<!-- ai-qa:user:start -->",
      "<!-- ai-qa:user:start -->\n<!-- ai-qa:managed:end -->",
    );

    expect(() =>
      mergeManagedSkill({
        source,
        existing,
        confirmManagedReplacement: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "skill.invalid_markers" }));
  });

  it("accepts CRLF structure without a false edit and preserves CRLF user bytes", () => {
    const installed = mergeManagedSkill({
      source,
      confirmManagedReplacement: false,
    }).content;
    const crlfUser = "\r\nLocal CRLF note  \r\n";
    const existing = installed
      .replace(
        "<!-- ai-qa:user:start -->\n<!-- ai-qa:user:end -->",
        `<!-- ai-qa:user:start -->${crlfUser}<!-- ai-qa:user:end -->`,
      )
      .replace(/(?<!\r)\n/g, "\r\n");

    const result = mergeManagedSkill({
      source,
      existing,
      confirmManagedReplacement: false,
    });

    expect(result.changed).toBe(false);
    expect(result.content).toContain(
      `<!-- ai-qa:user:start -->${crlfUser}<!-- ai-qa:user:end -->`,
    );
  });
});
