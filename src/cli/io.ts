import { z } from "zod";
import { AiQaError } from "../core/errors.js";
import type { CliContext } from "./context.js";

export async function readJsonInput<T>(
  context: CliContext,
  schema: z.ZodType<T>,
): Promise<T> {
  const source = await context.readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new AiQaError("input.invalid_json", "stdin must contain valid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AiQaError(
      "input.schema_invalid",
      "stdin JSON does not match the expected schema",
      {},
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.filter(
            (part): part is string | number => typeof part !== "symbol",
          ),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

export function writeJson(context: CliContext, value: unknown): void {
  context.writeStdout(`${JSON.stringify(value)}\n`);
}
