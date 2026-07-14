import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { atomicWriteFile } from "./atomic-write.js";

export function serializeJsonLines(records: readonly unknown[]): string {
  return records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function writeJsonLines(
  path: string,
  records: readonly unknown[],
): Promise<void> {
  return atomicWriteFile(path, serializeJsonLines(records));
}

export async function readJsonLines<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const content = await readFile(path, "utf8");
  if (content.length === 0) return [];
  if (!content.endsWith("\n")) {
    throw new Error("Non-empty JSONL files must be newline-terminated");
  }
  return content
    .slice(0, -1)
    .split("\n")
    .map((line) => schema.parse(JSON.parse(line)));
}
