import { randomUUID } from "node:crypto";

export function createId(
  prefix: "run" | "event" | "evidence" | "case" | "step",
): string {
  return `${prefix}-${randomUUID()}`;
}
