import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { createCapturedCli } from "../helpers/cli-context.js";
import { projectConfig } from "../helpers/project-fixture.js";

describe("read-only config CLI", () => {
  it("validates and returns a schema-v3 config without filesystem mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-config-validate-"));
    const captured = createCapturedCli({
      cwd: root,
      readStdin: () => Promise.resolve(JSON.stringify(projectConfig())),
    });
    expect(
      await runCli(["config", "validate", "--stdin-json"], captured.context),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(""))).toEqual({
      status: "valid",
      config: projectConfig(),
    });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([1, 2] as const)(
    "rejects stored schema-v%s input for new config validation",
    async (schemaVersion) => {
      const captured = createCapturedCli({
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({ ...projectConfig(), schemaVersion }),
          ),
      });
      expect(
        await runCli(["config", "validate", "--stdin-json"], captured.context),
      ).toBe(1);
      expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
        error: { code: "input.invalid_json" },
      });
    },
  );

  it.each(["init", "configure"])(
    "does not expose the removed %s command",
    async (name) => {
      const captured = createCapturedCli();
      expect(await runCli([name], captured.context)).toBe(1);
      expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
        error: { code: "commander.unknownCommand" },
      });
    },
  );

  it.each([
    {
      name: "skill generate",
      args: ["skill", "generate"],
      errorCode: "commander.unknownCommand",
    },
    {
      name: "project skill sync",
      args: ["skill", "sync"],
      errorCode: "commander.missingMandatoryOptionValue",
    },
    {
      name: "project skill check",
      args: ["skill", "check"],
      errorCode: "commander.missingMandatoryOptionValue",
    },
  ])("rejects removed $name without touching a project", async (testCase) => {
    const root = await mkdtemp(join(tmpdir(), "ai-qa-skill-scope-"));
    const captured = createCapturedCli({ cwd: root });

    expect(await runCli(testCase.args, captured.context)).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: { code: testCase.errorCode },
    });
    expect(await readdir(root)).toEqual([]);
  });
});
