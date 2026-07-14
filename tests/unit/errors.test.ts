import { describe, expect, it } from "vitest";
import { AiQaError, normalizeUnknownError } from "../../src/core/errors.js";

describe("normalizeUnknownError", () => {
  it("preserves an existing AiQaError", () => {
    const error = new AiQaError("run.specific", "Specific failure", {
      runId: "run-1",
    });

    expect(normalizeUnknownError(error)).toBe(error);
  });

  it("converts a node filesystem failure without leaking private fields", () => {
    const error = Object.assign(new Error("secret path /private/project"), {
      code: "EIO",
      syscall: "read",
      path: "/private/project/events.jsonl",
      input: "private input",
    });

    const normalized = normalizeUnknownError(error);

    expect(normalized).toMatchObject({
      code: "filesystem.operation_failed",
      message: "A filesystem operation failed",
      details: { code: "EIO", syscall: "read" },
    });
    expect(normalized.details).toEqual({ code: "EIO", syscall: "read" });
    expect(JSON.stringify(normalized.details)).not.toContain("private");
  });

  it("converts a non-system exception to the generic internal contract", () => {
    expect(normalizeUnknownError(new Error("private detail"))).toMatchObject({
      code: "internal.unexpected_error",
      message: "An unexpected internal error occurred",
      details: {},
    });
  });
});
