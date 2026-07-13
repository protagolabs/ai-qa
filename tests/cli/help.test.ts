import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { createCapturedCli } from "../helpers/cli-context.js";

describe("ai-qa CLI shell", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints help and exits successfully", async () => {
    const captured = createCapturedCli();

    const exitCode = await runCli(["--help"], captured.context);

    expect(exitCode).toBe(0);
    expect(captured.stdout.join("")).toContain("Usage: ai-qa");
  });

  it("returns a stable structured error for an unknown command", async () => {
    const captured = createCapturedCli();

    const exitCode = await runCli(["unknown-command"], captured.context);

    expect(exitCode).toBe(1);
    expect(captured.stderr).toEqual([
      '{"error":{"code":"commander.unknownCommand","message":"error: too many arguments. Expected 0 arguments but got 1: unknown-command."}}\n',
    ]);
  });

  it("preserves unrelated Commander error codes", async () => {
    const captured = createCapturedCli();

    const exitCode = await runCli(["--unknown-option"], captured.context);

    expect(exitCode).toBe(1);
    expect(captured.stderr.join("")).toContain("commander.unknownOption");
    expect(captured.stderr.join("")).not.toContain("commander.unknownCommand");
  });

  it("preserves excess-argument errors once subcommands exist", async () => {
    const captured = createCapturedCli();
    vi.spyOn(Command.prototype, "parseAsync").mockImplementation(function (
      this: Command,
    ) {
      this.command("known");
      return Promise.reject(
        new CommanderError(
          1,
          "commander.excessArguments",
          "error: too many arguments.",
        ),
      );
    });

    const exitCode = await runCli(["known", "extra"], captured.context);

    expect(exitCode).toBe(1);
    expect(captured.stderr).toEqual([
      '{"error":{"code":"commander.excessArguments","message":"error: too many arguments."}}\n',
    ]);
  });
});
