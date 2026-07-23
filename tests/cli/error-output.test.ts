import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readJsonInput } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/program.js";
import { AiQaError } from "../../src/core/errors.js";
import { createCliTestContext } from "../helpers/cli-context.js";

describe("error output contract", () => {
  it("reports unknown subcommands with commander's own message", async () => {
    const context = createCliTestContext();
    const exitCode = await runCli(
      ["definitely-not-a-command"],
      context.context,
    );
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
      [
        "run",
        "start",
        "--kind",
        "bogus",
        "--platform",
        "web",
        "--execution",
        "local",
        "--stdin-json",
      ],
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
      new AiQaError(
        "storage.lock_contended",
        "Lock is contended",
        {
          path: "/tmp/x",
        },
        { retryable: true },
      ),
    );
    writeErrorJson(context.context, new AiQaError("run.not_found", "Missing"));
    const [retryableLine, plainLine] = context.stderr;
    expect((JSON.parse(retryableLine!) as { error: unknown }).error).toEqual({
      code: "storage.lock_contended",
      message: "Lock is contended",
      retryable: true,
      details: { path: "/tmp/x" },
    });
    expect((JSON.parse(plainLine!) as { error: unknown }).error).toEqual({
      code: "run.not_found",
      message: "Missing",
    });
  });
});

describe("readJsonInput", () => {
  const schema = z.object({ goal: z.string().min(1) }).strict();

  it("reports malformed JSON as input.invalid_json", async () => {
    const context = createCliTestContext({ stdin: "{not json" });
    const error = await readJsonInput(context.context, schema).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AiQaError);
    expect((error as AiQaError).code).toBe("input.invalid_json");
    expect((error as AiQaError).details.cause).toEqual({
      code: "json.parse_error",
      message: expect.any(String),
    });
    expect((error as AiQaError).issues).toBeUndefined();
  });

  it("reports schema mismatches as input.schema_invalid with issues", async () => {
    const context = createCliTestContext({ stdin: '{"goal":""}' });
    const error = await readJsonInput(context.context, schema).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AiQaError);
    expect((error as AiQaError).code).toBe("input.schema_invalid");
    expect((error as AiQaError).issues).toEqual([
      expect.objectContaining({ path: ["goal"] }),
    ]);
  });
});
