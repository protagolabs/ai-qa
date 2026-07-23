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
    const help = captured.stdout.join("");
    expect(help).toContain("Usage: ai-qa");
    expect(help).toMatch(/config\s+validate AI QA configuration drafts/);
    expect(help).not.toMatch(/^\s+init(?:\s|\[)/m);
    expect(help).not.toMatch(/^\s+configure(?:\s|\[)/m);
  });

  it("documents the clear command and destructive records option", async () => {
    const captured = createCapturedCli();

    expect(await runCli(["--help"], captured.context)).toBe(0);
    expect(captured.stdout.join("")).toMatch(/^\s+clear\s/m);

    captured.stdout.length = 0;
    expect(await runCli(["clear", "--help"], captured.context)).toBe(0);
    const help = captured.stdout.join("");
    expect(help).toContain("--records");
    expect(help).toContain("delete all project-local AI QA records");
  });

  it.each([
    {
      args: ["config", "validate", "--help"],
      options: ["--stdin-json"],
      excludedOptions: ["--preview", "--confirm-checksum"],
    },
    {
      args: ["skill", "install", "--help"],
      options: ["--global", "--confirm-managed-replacement"],
      excludedOptions: ["--stdin-json", "--preview", "--confirm-checksum"],
    },
    {
      args: ["skill", "sync", "--help"],
      options: ["--global", "--confirm-managed-replacement"],
      excludedOptions: ["--stdin-json", "--preview", "--confirm-checksum"],
    },
    {
      args: ["skill", "check", "--help"],
      options: ["--global"],
      excludedOptions: [
        "--confirm-managed-replacement",
        "--stdin-json",
        "--preview",
        "--confirm-checksum",
      ],
    },
  ])(
    "documents the host-managed command surface for $args",
    async ({ args, options, excludedOptions }) => {
      const captured = createCapturedCli();

      expect(await runCli(args, captured.context)).toBe(0);

      const help = captured.stdout.join("");
      for (const option of options) expect(help).toContain(option);
      for (const option of excludedOptions) expect(help).not.toContain(option);
    },
  );

  it("exposes only global main Skill commands", async () => {
    const captured = createCapturedCli();

    expect(await runCli(["skill", "--help"], captured.context)).toBe(0);

    const help = captured.stdout.join("");
    expect(help).toMatch(/^\s+install\s/m);
    expect(help).toMatch(/^\s+sync\s/m);
    expect(help).toMatch(/^\s+check\s/m);
    expect(help).not.toMatch(/^\s+generate\s/m);
  });

  it("documents immutable run-group orchestration commands", async () => {
    const captured = createCapturedCli();

    expect(
      await runCli(["run-group", "start", "--help"], captured.context),
    ).toBe(0);
    const startHelp = captured.stdout.join("");
    expect(startHelp).toContain("--case <case-id...>");
    expect(startHelp).toContain("--all-active");
    expect(startHelp).toContain("--platform <platform...>");
    expect(startHelp).toContain("--execution <execution>");
    expect(startHelp).toContain("--stdin-json");

    captured.stdout.length = 0;
    expect(
      await runCli(["run-group", "cancel", "--help"], captured.context),
    ).toBe(0);
    expect(captured.stdout.join("")).toContain("--reason <reason>");

    captured.stdout.length = 0;
    expect(
      await runCli(["run-group", "resume", "--help"], captured.context),
    ).toBe(0);
    expect(captured.stdout.join("")).toContain("<group-id>");
  });

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
      '{"error":{"code":"commander.unknownCommand","message":"error: unknown command \'unknown-command\'"}}\n',
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
