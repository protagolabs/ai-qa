import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { createCapturedCli } from "../helpers/cli-context.js";

describe("host-owned project authority", () => {
  it("does not expose an AI QA repository-trust command", async () => {
    const captured = createCapturedCli();

    expect(await runCli(["trust", "status"], captured.context)).toBe(1);
    expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
      error: { code: "commander.unknownCommand" },
    });
  });
});
