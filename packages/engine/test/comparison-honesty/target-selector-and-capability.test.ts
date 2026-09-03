import { describe, expect, it } from "vitest";
import type { ComparisonPolicy, ComparisonRule, KnownDivergence } from "@supadiff/spec";
import {
  AmbiguousRuleSelectionError,
  compareStep,
  matchKnownDivergence,
  selectRule,
  targetSelectorMatches,
} from "../../src/index.js";
import { baseKnownDivergence, dataSelectObservation } from "./fixtures.js";

const now = new Date("2026-09-03T00:00:00.000Z");

describe("targetSelectorMatches: kind, backend, bounded semver range (§7.2)", () => {
  it("matches on kind alone when backend/versionRange are undeclared", () => {
    expect(targetSelectorMatches({ kind: "supalite-postgres" }, { kind: "supalite-postgres", version: "0.9.0" })).toBe(true);
  });

  it("a rule targeting supalite-sqlite@0.9.x MUST NOT match supalite-postgres@0.9.x", () => {
    expect(
      targetSelectorMatches(
        { kind: "supalite-sqlite", versionRange: "0.9.x" },
        { kind: "supalite-postgres", version: "0.9.0" },
      ),
    ).toBe(false);
  });

  it("declared backend MUST match exactly — same kind, different backend does not match", () => {
    expect(
      targetSelectorMatches(
        { kind: "supalite-postgres", backend: "postgres-16" },
        { kind: "supalite-postgres", backend: "postgres-15", version: "1.0.0" },
      ),
    ).toBe(false);
  });

  it("declared backend matches only when identical", () => {
    expect(
      targetSelectorMatches(
        { kind: "supalite-postgres", backend: "postgres-16" },
        { kind: "supalite-postgres", backend: "postgres-16", version: "1.0.0" },
      ),
    ).toBe(true);
  });

  it("a version outside the declared range does not match", () => {
    expect(
      targetSelectorMatches({ kind: "supalite-sqlite", versionRange: "0.9.x" }, { kind: "supalite-sqlite", version: "1.0.0" }),
    ).toBe(false);
  });

  it("a version inside the declared range matches", () => {
    expect(
      targetSelectorMatches({ kind: "supalite-sqlite", versionRange: "0.9.x" }, { kind: "supalite-sqlite", version: "0.9.5" }),
    ).toBe(true);
  });

  it("an unparsable identity version fails closed against a declared range (never a silent pass)", () => {
    expect(
      targetSelectorMatches(
        { kind: "supalite-sqlite", versionRange: "0.9.x" },
        { kind: "supalite-sqlite", version: "not-a-version" },
      ),
    ).toBe(false);
  });
});

function backendRule(overrides: Partial<ComparisonRule["selector"]> = {}): ComparisonRule {
  return {
    id: "rule.backend-scoped",
    version: "1",
    selector: {
      service: "data",
      operationId: "data.select",
      operationVersion: "1",
      observablePath: "/status",
      referenceTargetSelector: { kind: "fake" },
      candidateTargetSelector: { kind: "supalite-postgres", backend: "postgres-16", versionRange: "0.9.x" },
      ...overrides,
    },
    inputType: "string",
    rule: { kind: "exact" },
    strictness: "contract",
    rationale: "backend/version-scoped rule",
    evidence: [{ kind: "note", value: "test" }],
  };
}

function selectionCtx(candidate: { kind: string; backend?: string; version: string }) {
  return {
    service: "data",
    operationId: "data.select",
    operationVersion: "1",
    observablePath: "/status",
    reference: { kind: "fake", version: "1.0.0" },
    candidate,
    resolvedCapabilities: new Set<string>(),
  };
}

describe("selectRule honors backend/version specificity, never a false positive", () => {
  it("selects the backend+version-scoped rule when the candidate genuinely matches", () => {
    const policy: ComparisonPolicy = {
      format: "supadiff.comparison-policy",
      formatVersion: "1.0",
      policyId: "p",
      policyVersion: "1",
      rules: [backendRule()],
    };
    const selected = selectRule(
      policy,
      selectionCtx({ kind: "supalite-postgres", backend: "postgres-16", version: "0.9.2" }),
    );
    expect(selected?.id).toBe("rule.backend-scoped");
  });

  it("does not select the rule for a different backend on the same kind", () => {
    const policy: ComparisonPolicy = {
      format: "supadiff.comparison-policy",
      formatVersion: "1.0",
      policyId: "p",
      policyVersion: "1",
      rules: [backendRule()],
    };
    const selected = selectRule(
      policy,
      selectionCtx({ kind: "supalite-postgres", backend: "postgres-15", version: "0.9.2" }),
    );
    expect(selected).toBeUndefined();
  });

  it("does not select the rule for a version outside the declared range", () => {
    const policy: ComparisonPolicy = {
      format: "supadiff.comparison-policy",
      formatVersion: "1.0",
      policyId: "p",
      policyVersion: "1",
      rules: [backendRule()],
    };
    const selected = selectRule(
      policy,
      selectionCtx({ kind: "supalite-postgres", backend: "postgres-16", version: "1.4.0" }),
    );
    expect(selected).toBeUndefined();
  });
});

describe("capability-context rule selection (§8, workstream 3)", () => {
  function policyWith(rules: ComparisonRule[]): ComparisonPolicy {
    return { format: "supadiff.comparison-policy", formatVersion: "1.0", policyId: "p", policyVersion: "1", rules };
  }

  const generalRule: ComparisonRule = {
    id: "rule.general",
    version: "1",
    selector: {
      service: "data",
      operationId: "data.textSearch",
      operationVersion: "1",
      observablePath: "/rank",
      referenceTargetSelector: { kind: "fake" },
      candidateTargetSelector: { kind: "fake" },
    },
    inputType: "string",
    rule: { kind: "exact" },
    strictness: "contract",
    rationale: "strict exact match when the capability is exact",
    evidence: [{ kind: "note", value: "test" }],
  };

  const capabilityScopedRule: ComparisonRule = {
    id: "rule.approx-text-search",
    version: "1",
    selector: {
      ...generalRule.selector,
      capabilityContext: "data.text-search",
    },
    inputType: "string",
    rule: { kind: "invariant", predicate: { op: "eq", left: "/reference/rank", right: { literal: "present" } } },
    strictness: "contract",
    rationale: "token-presence only, declared approximation policy",
    evidence: [{ kind: "note", value: "test" }],
  };

  const ctxBase = {
    service: "data",
    operationId: "data.textSearch",
    operationVersion: "1",
    observablePath: "/rank",
    reference: { kind: "fake", version: "1.0.0" },
    candidate: { kind: "fake", version: "1.0.0" },
  };

  it("selects the capability-scoped rule when its capability is in the resolved set", () => {
    const selected = selectRule(policyWith([generalRule, capabilityScopedRule]), {
      ...ctxBase,
      resolvedCapabilities: new Set(["data.text-search"]),
    });
    expect(selected?.id).toBe("rule.approx-text-search");
  });

  it("falls back to the general rule when the capability is NOT in the resolved set (wrong/unsupported capability is never selected)", () => {
    const selected = selectRule(policyWith([generalRule, capabilityScopedRule]), {
      ...ctxBase,
      resolvedCapabilities: new Set(), // capability unresolved/unsupported
    });
    expect(selected?.id).toBe("rule.general");
  });

  it("falls back to the general rule when a different, unrelated capability resolved", () => {
    const selected = selectRule(policyWith([generalRule, capabilityScopedRule]), {
      ...ctxBase,
      resolvedCapabilities: new Set(["storage.signed-url.redeem"]),
    });
    expect(selected?.id).toBe("rule.general");
  });

  it("end-to-end via compareStep: accepted-approximation requires BOTH a matched capability-scoped rule AND a genuinely approximation-level resolution", () => {
    const policy = policyWith([generalRule, capabilityScopedRule]);
    const refObs = dataSelectObservation({ status: "success" });
    refObs.operation = { id: "data.textSearch", version: "1" };
    refObs.contractFields = { "/rank": "present" };
    refObs.coverage = { contractualFields: ["/rank"], diagnosticFields: [], ignoredFields: [], unassessedFields: [] };
    const candObs = { ...refObs, contractFields: { "/rank": "present" } };

    const results = compareStep({
      scenarioId: "scn.cap",
      scenarioDigest: `sha256:${"c".repeat(64)}`,
      stepId: "step.search",
      referenceSlot: "reference",
      candidateSlot: "candidate",
      referenceTarget: { kind: "fake", version: "1.0.0" },
      candidateTarget: { kind: "fake", version: "1.0.0" },
      referenceObservation: refObs,
      candidateObservation: candObs,
      referenceRawDigest: `sha256:${"a".repeat(64)}`,
      candidateRawDigest: `sha256:${"a".repeat(64)}`,
      policy,
      registry: [],
      now,
      resolvedCapabilities: new Set(["data.text-search"]),
      capabilityLevels: { "data.text-search": "approximation" },
    });
    expect(results.find((r) => r.observablePath === "/rank")?.outcome).toBe("accepted-approximation");
  });

  it("a matched capability-scoped rule alone (level not actually approximation/experimental) does NOT produce accepted-approximation", () => {
    const policy = policyWith([generalRule, capabilityScopedRule]);
    const refObs = dataSelectObservation({ status: "success" });
    refObs.operation = { id: "data.textSearch", version: "1" };
    refObs.contractFields = { "/rank": "present" };
    refObs.coverage = { contractualFields: ["/rank"], diagnosticFields: [], ignoredFields: [], unassessedFields: [] };
    const candObs = { ...refObs, contractFields: { "/rank": "present" } };

    const results = compareStep({
      scenarioId: "scn.cap",
      scenarioDigest: `sha256:${"c".repeat(64)}`,
      stepId: "step.search",
      referenceSlot: "reference",
      candidateSlot: "candidate",
      referenceTarget: { kind: "fake", version: "1.0.0" },
      candidateTarget: { kind: "fake", version: "1.0.0" },
      referenceObservation: refObs,
      candidateObservation: candObs,
      referenceRawDigest: `sha256:${"a".repeat(64)}`,
      candidateRawDigest: `sha256:${"a".repeat(64)}`,
      policy,
      registry: [],
      now,
      resolvedCapabilities: new Set(["data.text-search"]),
      capabilityLevels: {}, // no level recorded -> must not silently grant accepted-approximation
    });
    expect(results.find((r) => r.observablePath === "/rank")?.outcome).toBe("match-semantic");
  });

  it("ambiguity: two equally specific matching rules fail closed via AmbiguousRuleSelectionError, never a silent pick", () => {
    const dup: ComparisonRule = { ...capabilityScopedRule, id: "rule.approx-text-search-dup" };
    expect(() =>
      selectRule(policyWith([capabilityScopedRule, dup]), {
        ...ctxBase,
        resolvedCapabilities: new Set(["data.text-search"]),
      }),
    ).toThrow(AmbiguousRuleSelectionError);
  });
});

describe("known-divergence matching: one dimension at a time must independently block a match (§2.12, workstream 4/7)", () => {
  const refObs = dataSelectObservation({ status: "success" });
  const candObs = dataSelectObservation({ status: "error" });
  const registryCtxBase = {
    reference: { kind: "fake", version: "1.0.0" },
    candidate: { kind: "fake", version: "1.0.0" },
    scenarioId: "scn.fake-two-step",
    stepId: "step.select",
    observablePath: "/status",
    ruleId: "rule.data-select-status",
    ruleVersion: "1",
    failureFacts: { reference: { status: "success" }, candidate: { status: "error" } },
    now,
  };

  it("matches the intended baseline entry", () => {
    const result = matchKnownDivergence([baseKnownDivergence()], registryCtxBase);
    expect(result.status).toBe("matched");
  });

  it("a different candidate backend blocks the match", () => {
    const entry = baseKnownDivergence({ candidateSelector: { kind: "fake", backend: "other-backend" } });
    const result = matchKnownDivergence([entry], {
      ...registryCtxBase,
      candidate: { kind: "fake", backend: "real-backend", version: "1.0.0" },
    });
    expect(result.status).toBe("none");
  });

  it("a version outside the entry's declared range blocks the match", () => {
    const entry = baseKnownDivergence({ candidateSelector: { kind: "fake", versionRange: "0.8.x" } });
    const result = matchKnownDivergence([entry], {
      ...registryCtxBase,
      candidate: { kind: "fake", version: "0.9.0" },
    });
    expect(result.status).toBe("none");
  });

  it("a different observable path blocks the match", () => {
    const entry = baseKnownDivergence({ observableSelector: "/rows" });
    expect(matchKnownDivergence([entry], registryCtxBase).status).toBe("none");
  });

  it("a different rule id blocks the match", () => {
    const entry = baseKnownDivergence({ rule: { id: "rule.other", version: "1" } });
    expect(matchKnownDivergence([entry], registryCtxBase).status).toBe("none");
  });

  it("a failure predicate that evaluates false blocks the match (never matches on error text alone)", () => {
    const entry = baseKnownDivergence({
      expectedFailure: { predicate: { op: "eq", left: "/reference/status", right: { literal: "impossible-value" } } },
    });
    expect(matchKnownDivergence([entry], registryCtxBase).status).toBe("none");
  });

  it("a different scenario id blocks the match", () => {
    const entry = baseKnownDivergence({ scenarioSelector: { scenarioId: "scn.other" } });
    expect(matchKnownDivergence([entry], registryCtxBase).status).toBe("none");
  });

  it("a different step id blocks the match", () => {
    const entry = baseKnownDivergence({ stepSelector: { stepId: "step.other" } });
    expect(matchKnownDivergence([entry], registryCtxBase).status).toBe("none");
  });

  it("swapping reference/candidate target selectors blocks the match (direction matters)", () => {
    const entry = baseKnownDivergence({
      referenceSelector: { kind: "fake", backend: "reference-only-backend" },
      candidateSelector: { kind: "fake" },
    });
    const result = matchKnownDivergence([entry], {
      ...registryCtxBase,
      reference: { kind: "fake", version: "1.0.0" }, // no "reference-only-backend"
      candidate: { kind: "fake", backend: "reference-only-backend", version: "1.0.0" },
    });
    expect(result.status).toBe("none");
  });

  it("a declared capability that does not match the resolved capability blocks the match", () => {
    const entry = baseKnownDivergence({ capability: "data.text-search" });
    const result = matchKnownDivergence([entry], { ...registryCtxBase, capability: undefined });
    expect(result.status).toBe("none");
  });

  it("a registry entry registered for a different failure (B) never reclassifies a different failure (A) on the same path", () => {
    const entryForFailureB = baseKnownDivergence({
      expectedFailure: { predicate: { op: "eq", left: "/reference/status", right: { literal: "timeout" } } },
    });
    // Our observed failure is candidate.status === "error", not "timeout" (failure A).
    const result = matchKnownDivergence([entryForFailureB], registryCtxBase);
    expect(result.status).toBe("none");
  });
});

describe("KnownDivergence status/expiry gating (unchanged behavior, re-verified against the new matcher)", () => {
  it("a wont-fix entry that has expired does not classify", () => {
    const entry: KnownDivergence = baseKnownDivergence({
      status: "wont-fix",
      verifiedAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2025-06-01T00:00:00.000Z",
    });
    // wont-fix is not "active", so it is not even a structural candidate.
    const result = matchKnownDivergence([entry], {
      reference: { kind: "fake", version: "1.0.0" },
      candidate: { kind: "fake", version: "1.0.0" },
      scenarioId: "scn.fake-two-step",
      stepId: "step.select",
      observablePath: "/status",
      ruleId: "rule.data-select-status",
      ruleVersion: "1",
      failureFacts: { reference: { status: "success" }, candidate: { status: "error" } },
      now,
    });
    expect(result.status).toBe("none");
  });
});
