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

  it("preserves code-unit order for root and nested integer-like keys", () => {
    const value = {
      é: "accent",
      "2": "two",
      nested: { ä: "umlaut", "2": 2, _: "underscore", "10": 10 },
      "!": "bang",
      "10": "ten",
    };

    expect(canonicalJson(value)).toBe(
      '{"!":"bang","10":"ten","2":"two","nested":{"10":10,"2":2,"_":"underscore","ä":"umlaut"},"é":"accent"}',
    );
    expect(sha256Canonical(value)).toBe(
      sha256Canonical({
        "!": "bang",
        "10": "ten",
        "2": "two",
        nested: { "10": 10, _: "underscore", "2": 2, ä: "umlaut" },
        é: "accent",
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
