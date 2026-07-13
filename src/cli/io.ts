import { z } from "zod";
import { AiQaError } from "../core/errors.js";
import type { CliContext } from "./context.js";

export async function readJsonInput<T>(
  context: CliContext,
  schema: z.ZodType<T>,
): Promise<T> {
  const source = await context.readStdin();
  try {
    return schema.parse(JSON.parse(source));
  } catch (error: unknown) {
    throw new AiQaError(
      "input.invalid_json",
      "stdin must contain schema-valid JSON",
      {
        cause: String(error),
      },
    );
  }
}

export function writeJson(context: CliContext, value: unknown): void {
  context.writeStdout(`${JSON.stringify(value)}\n`);
}
