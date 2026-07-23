import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { createCliTestContext } from "../helpers/cli-context.js";

describe("error output contract", () => {
  it("reports unknown subcommands with commander's own message", async () => {
    const context = createCliTestContext();
    const exitCode = await runCli(["definitely-not-a-command"], context.context);
    expect(exitCode).toBe(1);
    const payload = JSON.parse(context.stderr.join("")) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("commander.unknownCommand");
    expect(payload.error.message).toContain("definitely-not-a-command");
    expect(payload.error.message).not.toContain("too many arguments");
  });

  it("reports the real package version", async () => {
    const context = createCliTestContext();
    const exitCode = await runCli(["--version"], context.context);
    expect(exitCode).toBe(0);
    const { createRequire } = await import("node:module");
    const pkg = createRequire(import.meta.url)("../../package.json") as {
      version: string;
    };
    expect(context.stdout.join("")).toContain(pkg.version);
  });

  it("emits issues for top-level option validation failures", async () => {
    const context = createCliTestContext();
    const exitCode = await runCli(
      ["run", "start", "--kind", "bogus", "--platform", "web", "--execution", "local", "--stdin-json"],
      context.context,
    );
    expect(exitCode).toBe(1);
    const payload = JSON.parse(context.stderr.join("")) as {
      error: { code: string; issues?: { path: unknown[]; message: string }[] };
    };
    expect(payload.error.code).toBe("schema.validation_failed");
    expect(payload.error.issues?.length).toBeGreaterThan(0);
  });

  it("serializes retryable only when true and omits empty details and issues", async () => {
    const { AiQaError } = await import("../../src/core/errors.js");
    const { writeErrorJson } = await import("../../src/cli/program.js");
    const context = createCliTestContext();
    writeErrorJson(
      context.context,
      new AiQaError("storage.lock_contended", "Lock is contended", {
        path: "/tmp/x",
      }, { retryable: true }),
    );
    writeErrorJson(context.context, new AiQaError("run.not_found", "Missing"));
    const [retryableLine, plainLine] = context.stderr;
    expect(JSON.parse(retryableLine!).error).toEqual({
      code: "storage.lock_contended",
      message: "Lock is contended",
      retryable: true,
      details: { path: "/tmp/x" },
    });
    expect(JSON.parse(plainLine!).error).toEqual({
      code: "run.not_found",
      message: "Missing",
    });
  });
});
