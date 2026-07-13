import { readFile } from "node:fs/promises";
import type { z } from "zod";

export async function readJsonLines<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const content = await readFile(path, "utf8");
  if (content.length === 0) return [];
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => schema.parse(JSON.parse(line)));
}
