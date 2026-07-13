import { createHash } from "node:crypto";
import { assertJsonValue, type JsonValue } from "./json-value.js";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodePrimitive(value: null | boolean | number | string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("JSON primitive could not be encoded");
  }
  return encoded;
}

function serialize(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((child) => serialize(child)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => {
        const child = value[key];
        if (child === undefined) {
          throw new TypeError("JSON object property could not be encoded");
        }
        return `${encodePrimitive(key)}:${serialize(child)}`;
      });
    return `{${entries.join(",")}}`;
  }
  return encodePrimitive(value);
}

export function canonicalJson(value: unknown): string {
  assertJsonValue(value);
  return serialize(value);
}

export function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
