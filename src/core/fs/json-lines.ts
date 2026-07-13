import { readFile } from "node:fs/promises";
import type { z } from "zod";

export async function readJsonLines<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const content = await readFile(path, "utf8");
  if (content.length === 0) return [];
  const records = content.endsWith("\n") ? content.slice(0, -1) : content;
  return records.split("\n").map((line) => schema.parse(JSON.parse(line)));
}
