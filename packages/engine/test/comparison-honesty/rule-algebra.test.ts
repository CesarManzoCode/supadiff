import { describe, expect, it } from "vitest";
import type { RuleExpression, SemanticObservation } from "@supadiff/spec";
import { evaluateRule } from "../../src/index.js";

function obs(overrides: Partial<SemanticObservation> = {}): SemanticObservation {
  return {
    format: "supadiff.semantic-observation",
    projector: { id: "test", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "data",
    operation: { id: "test.op", version: "1" },
    contractFields: {},
    ignoredFields: [],
    relationships: [],
    stateFacts: [],
    coverage: {
      contractualFields: [],
      diagnosticFields: [],
      ignoredFields: [],
      unassessedFields: [],
    },
    ...overrides,
  };
}

function evalAt(
  rule: RuleExpression,
  referenceValue: unknown,
  candidateValue: unknown,
  extra: Partial<{
    referenceObservation: SemanticObservation;
    candidateObservation: SemanticObservation;
    path: string;
  }> = {},
) {
  return evaluateRule(rule, {
    ruleRef: { id: "test.rule", version: "1" },
    path: extra.path ?? "/field",
    referenceValue,
    candidateValue,
    referenceObservation: extra.referenceObservation ?? obs(),
    candidateObservation: extra.candidateObservation ?? obs(),
  });
}

describe("object rule: type safety, never coerces null/non-object to {} (§7.3, §15.3)", () => {
  const rule: RuleExpression = {
    kind: "object",
    unknown: "fail",
    fields: [{ field: "/x", rule: { kind: "exact" } }],
  };

  it("matches two genuine equal objects", () => {
    expect(evalAt(rule, { x: 1 }, { x: 1 }).verdict).toBe("satisfied");
  });

  it("null does NOT spuriously match an empty-shaped object", () => {
    expect(evalAt(rule, null, {}).verdict).toBe("failed");
  });

  it("missing (undefined) does NOT spuriously match an object", () => {
    expect(evalAt(rule, undefined, { x: 1 }).verdict).toBe("failed");
  });

  it("an array is never treated as an object", () => {
    expect(evalAt(rule, [], {}).verdict).toBe("failed");
  });

  it("both sides null/undefined together are treated as equal (no object involved)", () => {
    expect(evalAt(rule, null, null).verdict).toBe("satisfied");
    expect(evalAt(rule, undefined, undefined).verdict).toBe("satisfied");
  });

  it("null vs undefined are distinct types and do not match", () => {
    expect(evalAt(rule, null, undefined).verdict).toBe("failed");
  });
});

describe("array rules: type safety, never coerces a non-array to [] (§7.3, §15.3)", () => {
  const orderedRule: RuleExpression = { kind: "ordered-collection", item: { kind: "exact" } };
  const unorderedRule: RuleExpression = { kind: "unordered-collection", item: { kind: "exact" } };
  const subsetRule: RuleExpression = {
    kind: "subset",
    expectedSide: "reference",
    item: { kind: "exact" },
  };

  it("ordered-collection: a string does not spuriously match []", () => {
    expect(evalAt(orderedRule, "not-an-array", []).verdict).toBe("failed");
  });

  it("unordered-collection: an object does not spuriously match []", () => {
    expect(evalAt(unorderedRule, {}, []).verdict).toBe("failed");
  });

  it("subset: null does not spuriously match []", () => {
    expect(evalAt(subsetRule, null, []).verdict).toBe("failed");
  });

  it("ordered-collection matches two identical arrays", () => {
    expect(evalAt(orderedRule, [1, 2], [1, 2]).verdict).toBe("satisfied");
  });
});

describe("subset: the item sub-rule is actually used, and multiplicity is preserved (§7.1, workstream 6)", () => {
  const itemRule: RuleExpression = {
    kind: "object",
    unknown: "fail",
    fields: [{ field: "/id", rule: { kind: "exact" } }],
  };
  const rule: RuleExpression = { kind: "subset", expectedSide: "reference", item: itemRule };

  it("matches when every expected item has a distinct semantically-equivalent actual item (raw values may differ elsewhere, item rule decides)", () => {
    // reference (expected) has 2 items; candidate (actual) has those 2 plus an extra one.
    const result = evalAt(rule, [{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }, { id: 3 }]);
    expect(result.verdict).toBe("satisfied");
  });

  it("fails when an expected item has no distinct actual match", () => {
    const result = evalAt(rule, [{ id: 1 }, { id: 2 }], [{ id: 1 }]);
    expect(result.verdict).toBe("failed");
  });

  it("preserves multiplicity: one actual item cannot satisfy two expected items", () => {
    // expected has two items with id 1; actual has only one — the second must fail to match.
    const result = evalAt(rule, [{ id: 1 }, { id: 1 }], [{ id: 1 }]);
    expect(result.verdict).toBe("failed");
  });
});

describe("unordered-collection with key: one-to-one matching, duplicate keys fail closed (§7.1, workstream 6)", () => {
  const rule: RuleExpression = {
    kind: "unordered-collection",
    key: "/id",
    item: { kind: "object", unknown: "fail", fields: [{ field: "/id", rule: { kind: "exact" } }] },
  };

  it("matches distinct-keyed items regardless of order", () => {
    const result = evalAt(rule, [{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }]);
    expect(result.verdict).toBe("satisfied");
  });

  it("a duplicate key on the reference side fails closed instead of an ambiguous pick", () => {
    const result = evalAt(rule, [{ id: 1 }, { id: 1 }], [{ id: 1 }, { id: 1 }]);
    expect(result.verdict).toBe("failed");
    expect(result.summary).toMatch(/duplicate key/);
  });

  it("a duplicate key on the candidate side (deceptive duplicate keys) fails closed, never a false match", () => {
    const result = evalAt(rule, [{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 1 }]);
    expect(result.verdict).toBe("failed");
  });
});

describe("relationship: subject AND object must correspond, not just predicate presence (§7.1, §15.3)", () => {
  const rule: RuleExpression = { kind: "relationship", predicate: "session.belongs-to-actor" };

  it("matches when subject and object correspond on both sides", () => {
    const referenceObservation = obs({
      relationships: [
        { predicate: "session.belongs-to-actor", subject: "session-3", object: "actor.owner" },
      ],
    });
    const candidateObservation = obs({
      relationships: [
        { predicate: "session.belongs-to-actor", subject: "session-3", object: "actor.owner" },
      ],
    });
    expect(
      evalAt(rule, undefined, undefined, { referenceObservation, candidateObservation }).verdict,
    ).toBe("satisfied");
  });

  it("MUST fail when the predicate exists on both sides but subject/object differ (wrong actor's session)", () => {
    const referenceObservation = obs({
      relationships: [
        { predicate: "session.belongs-to-actor", subject: "sessionA", object: "actor.alice" },
      ],
    });
    const candidateObservation = obs({
      relationships: [
        { predicate: "session.belongs-to-actor", subject: "sessionB", object: "actor.bob" },
      ],
    });
    expect(
      evalAt(rule, undefined, undefined, { referenceObservation, candidateObservation }).verdict,
    ).toBe("failed");
  });

  it("fails when the predicate is missing on one side", () => {
    const referenceObservation = obs({
      relationships: [{ predicate: "session.belongs-to-actor", subject: "s", object: "o" }],
    });
    const candidateObservation = obs({ relationships: [] });
    expect(
      evalAt(rule, undefined, undefined, { referenceObservation, candidateObservation }).verdict,
    ).toBe("failed");
  });
});

describe("token-claims: present/absent/equals, never comparing raw token bytes", () => {
  it("present: passes when the claim exists on both sides regardless of value", () => {
    const rule: RuleExpression = {
      kind: "token-claims",
      claims: [{ claim: "sub", predicate: "present" }],
    };
    expect(evalAt(rule, { sub: "user-a" }, { sub: "user-b" }).verdict).toBe("satisfied");
  });

  it("absent: fails when the claim is present on either side", () => {
    const rule: RuleExpression = {
      kind: "token-claims",
      claims: [{ claim: "role", predicate: "absent" }],
    };
    expect(evalAt(rule, {}, { role: "admin" }).verdict).toBe("failed");
  });

  it("equals: requires the same literal value on both sides", () => {
    const rule: RuleExpression = {
      kind: "token-claims",
      claims: [{ claim: "role", predicate: "equals", value: "authenticated" }],
    };
    expect(evalAt(rule, { role: "authenticated" }, { role: "authenticated" }).verdict).toBe(
      "satisfied",
    );
    expect(evalAt(rule, { role: "authenticated" }, { role: "service_role" }).verdict).toBe(
      "failed",
    );
  });

  it("never inspects the raw token string — only decoded claim fields are ever passed in", () => {
    const rule: RuleExpression = {
      kind: "token-claims",
      claims: [{ claim: "sub", predicate: "present" }],
    };
    const result = evalAt(rule, { sub: "u1" }, { sub: "u2" });
    expect(JSON.stringify(result)).not.toMatch(/^ey[A-Za-z0-9._-]{10,}/);
  });
});

describe("temporal-invariant: real predicate evaluation over semantic facts", () => {
  it("satisfied when the bounded interval predicate holds on both sides", () => {
    const rule: RuleExpression = {
      kind: "temporal-invariant",
      expression: { op: "eq", left: "/reference/expires_in", right: { literal: 3600 } },
    };
    const referenceObservation = obs({ contractFields: { "/expires_in": 3600 } });
    const candidateObservation = obs({ contractFields: { "/expires_in": 3600 } });
    expect(
      evalAt(rule, undefined, undefined, { referenceObservation, candidateObservation }).verdict,
    ).toBe("satisfied");
  });

  it("fails when the bounded interval predicate does not hold", () => {
    const rule: RuleExpression = {
      kind: "temporal-invariant",
      expression: { op: "eq", left: "/reference/expires_in", right: { literal: 3600 } },
    };
    const referenceObservation = obs({ contractFields: { "/expires_in": 10 } });
    const candidateObservation = obs({ contractFields: { "/expires_in": 10 } });
    expect(
      evalAt(rule, undefined, undefined, { referenceObservation, candidateObservation }).verdict,
    ).toBe("failed");
  });
});

describe("url-redemption: applies RedemptionContract, never compares URL strings (§6.3, §7.1)", () => {
  function redemptionObs(status: string, bytesDigest?: string): SemanticObservation {
    return obs({
      contractFields: {
        "/status": status,
        ...(bytesDigest !== undefined ? { "/bytesDigest": bytesDigest } : {}),
      },
    });
  }

  it("different signed URLs (never compared) with equivalent redemption -> match", () => {
    const rule: RuleExpression = {
      kind: "url-redemption",
      expected: { expectStatusCategory: "success", bytesMustMatch: false },
    };
    const referenceObservation = redemptionObs("success");
    const candidateObservation = redemptionObs("success");
    const result = evalAt(rule, "success", "success", {
      referenceObservation,
      candidateObservation,
      path: "/status",
    });
    expect(result.verdict).toBe("satisfied");
  });

  it("wrong expected status category fails even though both sides agree with each other", () => {
    const rule: RuleExpression = {
      kind: "url-redemption",
      expected: { expectStatusCategory: "expired", bytesMustMatch: false },
    };
    const referenceObservation = redemptionObs("success");
    const candidateObservation = redemptionObs("success");
    const result = evalAt(rule, "success", "success", {
      referenceObservation,
      candidateObservation,
      path: "/status",
    });
    expect(result.verdict).toBe("failed");
  });

  it("bytesMustMatch: identical status but different bytes digest fails", () => {
    const rule: RuleExpression = {
      kind: "url-redemption",
      expected: { expectStatusCategory: "success", bytesMustMatch: true },
    };
    const referenceObservation = redemptionObs("success", "sha256:aaa");
    const candidateObservation = redemptionObs("success", "sha256:bbb");
    const result = evalAt(rule, "success", "success", {
      referenceObservation,
      candidateObservation,
      path: "/status",
    });
    expect(result.verdict).toBe("failed");
  });

  it("bytesMustMatch: identical status and identical bytes digest matches", () => {
    const rule: RuleExpression = {
      kind: "url-redemption",
      expected: { expectStatusCategory: "success", bytesMustMatch: true },
    };
    const referenceObservation = redemptionObs("success", "sha256:aaa");
    const candidateObservation = redemptionObs("success", "sha256:aaa");
    const result = evalAt(rule, "success", "success", {
      referenceObservation,
      candidateObservation,
      path: "/status",
    });
    expect(result.verdict).toBe("satisfied");
  });
});

describe("state-readback: uses before/after + DeltaContract explicitly, not mere presence (§7.1, workstream 6)", () => {
  function readbackObs(before: unknown, after: unknown): SemanticObservation {
    return obs({ contractFields: { "/before": before, "/after": after } });
  }
  const rule: RuleExpression = {
    kind: "state-readback",
    before: "/before",
    after: "/after",
    delta: { expectedChangedPaths: ["/row/name"], expectedUnchangedPaths: ["/row/id"] },
  };

  it("matches the expected mutation on both sides", () => {
    const referenceObservation = readbackObs(
      { row: { id: 1, name: "old" } },
      { row: { id: 1, name: "new" } },
    );
    const candidateObservation = readbackObs(
      { row: { id: 1, name: "old" } },
      { row: { id: 1, name: "new" } },
    );
    expect(
      evalAt(rule, undefined, undefined, { referenceObservation, candidateObservation }).verdict,
    ).toBe("satisfied");
  });

  it("fails on an unexpected mutation (a field expected unchanged actually changed)", () => {
    const referenceObservation = readbackObs(
      { row: { id: 1, name: "old" } },
      { row: { id: 1, name: "new" } },
    );
    const candidateObservation = readbackObs(
      { row: { id: 1, name: "old" } },
      { row: { id: 99, name: "new" } },
    );
    const result = evalAt(rule, undefined, undefined, {
      referenceObservation,
      candidateObservation,
    });
    expect(result.verdict).toBe("failed");
    expect(result.summary).toMatch(/remain unchanged.*candidate.*changed/);
  });

  it("fails when the expected mutation did not happen (unchanged-required-field-did-change is the mirror case)", () => {
    const referenceObservation = readbackObs(
      { row: { id: 1, name: "old" } },
      { row: { id: 1, name: "old" } },
    );
    const candidateObservation = readbackObs(
      { row: { id: 1, name: "old" } },
      { row: { id: 1, name: "new" } },
    );
    const result = evalAt(rule, undefined, undefined, {
      referenceObservation,
      candidateObservation,
    });
    expect(result.verdict).toBe("failed");
    expect(result.summary).toMatch(/expected .* to change on reference but it did not/);
  });

  it("fails when the before or after snapshot is missing", () => {
    const referenceObservation = obs({ contractFields: { "/before": { row: {} } } }); // no /after
    const candidateObservation = readbackObs({ row: {} }, { row: {} });
    const result = evalAt(rule, undefined, undefined, {
      referenceObservation,
      candidateObservation,
    });
    expect(result.verdict).toBe("failed");
  });
});

describe("explicit-ignore: never degrades into a wildcard, requires rationale/evidence", () => {
  it("is verdict not-applicable and carries its reason in the explanation", () => {
    const rule: RuleExpression = {
      kind: "explicit-ignore",
      reason: "diagnostic timestamp jitter, not a contractual field",
      evidence: [{ kind: "note", value: "GT §6" }],
    };
    const result = evalAt(rule, "x", "y");
    expect(result.verdict).toBe("not-applicable");
    expect(result.summary).toContain("diagnostic timestamp jitter");
  });
});
