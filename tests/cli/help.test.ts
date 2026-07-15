import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../../src/cli/context.js";
import { createProgram, runCli } from "../../src/cli/program.js";
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

  it.each([
    {
      args: ["init", "--help"],
      options: ["--stdin-json", "--preview", "--confirm-checksum"],
    },
    {
      args: ["configure", "--help"],
      options: ["--stdin-json", "--preview", "--confirm-checksum"],
    },
    {
      args: ["skill", "generate", "--help"],
      options: ["--stdin-json", "--preview", "--confirm-checksum"],
    },
    { args: ["skill", "check", "--help"], options: ["--global"] },
    {
      args: ["skill", "sync", "--help"],
      options: ["--global", "--stdin-json", "--preview", "--confirm-checksum"],
    },
  ])(
    "documents the project setup command surface for $args",
    async ({ args, options }) => {
      const captured = createCapturedCli();

      expect(await runCli(args, captured.context)).toBe(0);

      const help = captured.stdout.join("");
      for (const option of options) expect(help).toContain(option);
    },
  );

  it("preserves the caller context identity in program output closures", async () => {
    const captured = createCapturedCli();
    let usedOriginalContext = false;
    captured.context.writeStdout = function (this: CliContext, value: string) {
      usedOriginalContext = this === captured.context;
      captured.stdout.push(value);
    };

    const exitCode = await runCli(["--help"], captured.context);

    expect(exitCode).toBe(0);
    expect(usedOriginalContext).toBe(true);
  });

  it("keeps non-error program output injected through the caller context", () => {
    const captured = createCapturedCli();
    const program = createProgram(captured.context);

    program.outputHelp({ error: true });

    expect(captured.stderr.join("")).toContain("Usage: ai-qa");
  });

  it("returns a stable structured error for an unknown command", async () => {
    const captured = createCapturedCli();

    const exitCode = await runCli(["unknown-command"], captured.context);

    expect(exitCode).toBe(1);
    expect(captured.stderr).toEqual([
      '{"error":{"code":"commander.unknownCommand","message":"error: too many arguments. Expected 0 arguments but got 1."}}\n',
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
