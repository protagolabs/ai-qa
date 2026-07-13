import { createHash } from "node:crypto";
import { assertJsonValue, type JsonValue } from "./json-value.js";

function normalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, normalize(child as JsonValue)]),
    ) as { [key: string]: JsonValue };
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  assertJsonValue(value);
  return JSON.stringify(normalize(value));
}

export function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
