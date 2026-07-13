import { z } from "zod";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isJsonValueRecursive(
  value: unknown,
  ancestors: WeakSet<object>,
): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.getPrototypeOf(value) !== Array.prototype) return false;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) return false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor) ||
          !isJsonValueRecursive(descriptor.value, ancestors)
        ) {
          return false;
        }
      }
      return true;
    }

    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isJsonValueRecursive(descriptor.value, ancestors)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return isJsonValueRecursive(value, new WeakSet<object>());
  } catch {
    return false;
  }
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError("Value must contain only JSON-safe data");
  }
}

export const jsonValueSchema = z.custom<JsonValue>(isJsonValue, {
  message: "Value must contain only JSON-safe data",
});
