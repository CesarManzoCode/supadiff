import { describe, expect, it } from "vitest";
import { parseComparisonPolicy, SpecValidationError } from "../src/index.js";
import type { ComparisonPolicy } from "../src/index.js";

function basePolicy(): ComparisonPolicy {
  return {
    format: "supadiff.comparison-policy",
    formatVersion: "1.0",
    policyId: "policy.minimal",
    policyVersion: "1",
    rules: [
      {
        id: "rule.data-select-rows",
        version: "1",
        selector: {
          service: "data",
          operationId: "data.select",
          operationVersion: "1",
          observablePath: "/rows",
          referenceTargetSelector: { kind: "fake" },
          candidateTargetSelector: { kind: "fake" },
        },
        inputType: "array",
        rule: { kind: "unordered-collection", item: { kind: "exact" }, key: "/id" },
        strictness: "contract",
        rationale: "No order requested; compare as a set keyed by id.",
        evidence: [{ kind: "note", value: "contract §7.3" }],
      },
    ],
  };
}

describe("parseComparisonPolicy", () => {
  it("accepts a valid policy", () => {
    const p = parseComparisonPolicy(basePolicy() as never);
    expect(p.rules).toHaveLength(1);
  });

  it("rejects a wildcard observable path", () => {
    const p = basePolicy();
    p.rules[0]!.selector.observablePath = "*";
    expect(() => parseComparisonPolicy(p as never)).toThrow(SpecValidationError);
  });

  it("rejects two rules with an identically specific selector (ambiguous)", () => {
    const p = basePolicy();
    p.rules.push({ ...p.rules[0]!, id: "rule.data-select-rows-dup" });
    try {
      parseComparisonPolicy(p as never);
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(SpecValidationError);
      expect(
        (e as SpecValidationError).issues.some((i) => i.code === "ambiguous-rule-selector"),
      ).toBe(true);
    }
  });

  it("rejects an unknown rule kind (closed algebra)", () => {
    const p = basePolicy() as unknown as { rules: Array<{ rule: unknown }> };
    p.rules[0]!.rule = { kind: "regex-match", pattern: ".*" };
    expect(() => parseComparisonPolicy(p as never)).toThrow();
  });
});
