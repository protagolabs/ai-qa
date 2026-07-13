import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256Canonical,
} from "../../src/core/canonical-json.js";

describe("canonical JSON", () => {
  it("sorts keys by locale-independent ECMAScript code units", () => {
    const value = {
      é: 7,
      "a!": 5,
      _: 3,
      ä: 6,
      Z: 2,
      "!": 1,
      a: 4,
      "😀": 8,
    };

    expect(canonicalJson(value)).toBe(
      '{"!":1,"Z":2,"_":3,"a":4,"a!":5,"ä":6,"é":7,"😀":8}',
    );
    expect(sha256Canonical(value)).toBe(
      sha256Canonical({
        "😀": 8,
        a: 4,
        "!": 1,
        ä: 6,
        Z: 2,
        é: 7,
        _: 3,
        "a!": 5,
      }),
    );
  });

  it("accepts nested JSON and rejects every unsupported runtime value", () => {
    const valid = {
      array: [null, true, false, 0, 1.5, "value", { nested: ["ok"] }],
    };
    expect(canonicalJson(valid)).toBe(
      '{"array":[null,true,false,0,1.5,"value",{"nested":["ok"]}]}',
    );

    class Box {
      value = "not-plain";
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const invalid of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1n,
      new Date("2026-07-13T00:00:00.000Z"),
      new Box(),
      () => "function",
      Symbol("symbol"),
      cyclic,
    ]) {
      expect(() => canonicalJson(invalid)).toThrow();
    }
  });
});
