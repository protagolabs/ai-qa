import { randomUUID } from "node:crypto";

export function createId(
  prefix: "run" | "event" | "evidence" | "case" | "step" | "recording",
): string {
  return `${prefix}-${randomUUID()}`;
}
