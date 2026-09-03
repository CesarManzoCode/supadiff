import { describe, expect, it } from "vitest";
import { canonicalizeJson, sha256OfCanonicalJson, scenario, step, actor } from "../src/index.js";
import { minimalScenario } from "./fixtures/minimal-scenario.js";

describe("RFC 8785 canonicalization characterization", () => {
  it("sorts object keys lexicographically regardless of insertion order", () => {
    const a = canonicalizeJson({ b: 1, a: 2, c: 3 } as never);
    const b = canonicalizeJson({ c: 3, a: 2, b: 1 } as never);
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("preserves array order (arrays are never sorted)", () => {
    expect(canonicalizeJson([3, 1, 2] as never)).toBe("[3,1,2]");
  });

  it("uses shortest round-trippable number representation", () => {
    expect(canonicalizeJson({ n: 1.0 } as never)).toBe('{"n":1}');
    expect(canonicalizeJson({ n: 100 } as never)).toBe('{"n":100}');
  });

  it("distinguishes null from absence and from empty structures", () => {
    expect(canonicalizeJson({ a: null } as never)).toBe('{"a":null}');
    expect(canonicalizeJson({ a: [] } as never)).toBe('{"a":[]}');
    expect(canonicalizeJson({ a: {} } as never)).toBe('{"a":{}}');
    expect(canonicalizeJson({} as never)).toBe("{}");
  });

  it("does not Unicode-normalize strings (NFC vs NFD stay distinct byte strings)", () => {
    // U+00E9 (precomposed "e with acute") vs "e" + U+0301 (combining acute accent).
    // Built from code points so the test is immune to source-file re-encoding.
    const nfc = String.fromCodePoint(0x00e9);
    const nfd = "e" + String.fromCodePoint(0x0301);
    expect(nfc).not.toBe(nfd); // sanity: genuinely different code point sequences
    const a = canonicalizeJson({ s: nfc } as never);
    const b = canonicalizeJson({ s: nfd } as never);
    // RFC 8785 canonicalizes the string as given; it is not a Unicode normalizer.
    expect(a).not.toBe(b);
  });

  it("is deterministic across repeated calls", () => {
    const value = { z: 1, a: [1, 2, { y: 2, x: 1 }], m: null };
    const first = canonicalizeJson(value as never);
    const second = canonicalizeJson(value as never);
    expect(first).toBe(second);
  });
});

describe("declarative TS builder produces byte-identical canonical JSON", () => {
  it("builder output and hand-authored JSON hash to the same digest", () => {
    const authored = minimalScenario();

    const built = scenario({
      ...authored,
      actors: authored.actors.map((a) => actor(a)),
      steps: authored.steps.map((s) => step(s)),
    });

    const authoredDigest = sha256OfCanonicalJson(authored as never);
    const builtDigest = sha256OfCanonicalJson(built as never);
    expect(builtDigest).toBe(authoredDigest);

    // Simulate "raw JSON equivalent": parse from a JSON string round-trip, as an
    // untrusted author's file would arrive on disk.
    const rawJsonRoundTrip = JSON.parse(JSON.stringify(authored));
    const rawDigest = sha256OfCanonicalJson(rawJsonRoundTrip as never);
    expect(rawDigest).toBe(authoredDigest);
  });

  it("key order in the JSON source never affects the digest", () => {
    const authored = minimalScenario();
    // Rebuild the same object inserting top-level keys in reverse order; canonical
    // JSON must be identical regardless of source insertion order at any depth.
    const reversedKeys = Object.keys(authored).reverse() as Array<keyof typeof authored>;
    const reordered = {} as typeof authored;
    for (const key of reversedKeys) {
      (reordered as Record<string, unknown>)[key] = authored[key];
    }
    expect(sha256OfCanonicalJson(reordered as never)).toBe(
      sha256OfCanonicalJson(authored as never),
    );
  });
});
