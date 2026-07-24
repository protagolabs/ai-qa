import { describe, expect, it } from "vitest";
import {
  AiQaError,
  extractErrorCause,
  normalizeUnknownError,
  toErrorCause,
} from "../../src/core/errors.js";

describe("toErrorCause", () => {
  it.each([
    {
      code: "EACCES",
      syscall: "open",
      expectedMessage: "The filesystem reported EACCES during open",
    },
    {
      code: "ENOTDIR",
      syscall: "lstat",
      expectedMessage: "The filesystem reported ENOTDIR during lstat",
    },
  ])(
    "sanitizes a $code filesystem cause",
    ({ code, syscall, expectedMessage }) => {
      const error = Object.assign(
        new Error(
          `${code}: operation failed, ${syscall} '/private/project/index.jsonl'`,
        ),
        {
          code,
          syscall,
          path: "/private/project/index.jsonl",
        },
      );

      const cause = toErrorCause(error);

      expect(cause).toEqual({ code, message: expectedMessage });
      expect(JSON.stringify(cause)).not.toContain("/private/project");
    },
  );

  it("preserves syntax error diagnostics", () => {
    expect(
      toErrorCause(new SyntaxError("Unexpected token at position 3")),
    ).toEqual({
      code: "json.parse_error",
      message: "Unexpected token at position 3",
    });
  });

  it("preserves non-errno coded error diagnostics", () => {
    const error = Object.assign(
      new TypeError("The encoded data was not valid for encoding utf-8"),
      { code: "ERR_ENCODING_INVALID_ENCODED_DATA" },
    );
    const expected = {
      code: "ERR_ENCODING_INVALID_ENCODED_DATA",
      message: "The encoded data was not valid for encoding utf-8",
    };

    expect(extractErrorCause(error)).toEqual(expected);
    expect(toErrorCause(error)).toEqual(expected);
  });
});

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
      details: {
        cause: {
          code: "EIO",
          message: "The filesystem reported EIO during read",
        },
        syscall: "read",
      },
    });
    expect(normalized.details).toEqual({
      cause: {
        code: "EIO",
        message: "The filesystem reported EIO during read",
      },
      syscall: "read",
    });
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
