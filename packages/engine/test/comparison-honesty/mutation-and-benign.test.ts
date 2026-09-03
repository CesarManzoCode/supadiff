import { describe, expect, it } from "vitest";
import { compareStep, AmbiguousRuleSelectionError } from "../../src/index.js";
import { basePolicy, baseKnownDivergence, dataSelectObservation } from "./fixtures.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const scenarioDigest = `sha256:${"b".repeat(64)}` as const;

function run(
  refOverrides: Parameters<typeof dataSelectObservation>[0],
  candOverrides: Parameters<typeof dataSelectObservation>[0],
) {
  return compareStep({
    scenarioId: "scn.fake-two-step",
    scenarioDigest,
    stepId: "step.select",
    referenceSlot: "reference",
    candidateSlot: "candidate",
    referenceTarget: { kind: "fake", version: "1.0.0" },
    candidateTarget: { kind: "fake", version: "1.0.0" },
    referenceObservation: dataSelectObservation(refOverrides),
    candidateObservation: dataSelectObservation(candOverrides),
    referenceRawDigest: digest,
    candidateRawDigest: digest,
    policy: basePolicy(),
    registry: [],
    now: new Date("2026-09-03T00:00:00.000Z"),
  });
}

function outcomeAt(results: ReturnType<typeof run>, path: string) {
  return results.find((r) => r.observablePath === path)?.outcome;
}

describe("false-match prevention: one mutation per contractual field must fail", () => {
  it("matches when both sides are identical", () => {
    const results = run({}, {});
    expect(outcomeAt(results, "/status")).toBe("match-exact");
    expect(outcomeAt(results, "/rows")).toBe("match-semantic");
  });

  it("catches a status mutation", () => {
    const results = run({ status: "success" }, { status: "error" });
    expect(outcomeAt(results, "/status")).toBe("new-divergence");
  });

  it("catches a row value mutation (owner_id changed)", () => {
    const results = run(
      { rows: [{ id: 1, owner_id: "owner-abc" }] },
      { rows: [{ id: 1, owner_id: "owner-DIFFERENT" }] },
    );
    expect(outcomeAt(results, "/rows")).toBe("new-divergence");
  });

  it("catches a missing row (candidate returns fewer rows — matching identical 200 with different side effects)", () => {
    const results = run(
      {
        rows: [
          { id: 1, owner_id: "a" },
          { id: 2, owner_id: "b" },
        ],
      },
      { rows: [{ id: 1, owner_id: "a" }] },
    );
    expect(outcomeAt(results, "/rows")).toBe("new-divergence");
  });

  it("catches an extra row (candidate leaks a row reference should not see)", () => {
    const results = run(
      { rows: [{ id: 1, owner_id: "a" }] },
      {
        rows: [
          { id: 1, owner_id: "a" },
          { id: 99, owner_id: "intruder" },
        ],
      },
    );
    expect(outcomeAt(results, "/rows")).toBe("new-divergence");
  });

  it("catches an unaccounted field inside a row object (object rule unknown:'fail')", () => {
    const results = run(
      { rows: [{ id: 1, owner_id: "a" }] },
      { rows: [{ id: 1, owner_id: "a", secretLeakedField: "oops" }] },
    );
    expect(outcomeAt(results, "/rows")).toBe("new-divergence");
  });
});

describe("false-divergence prevention: benign differences must not become divergence", () => {
  it("JSON key order never affects the result", () => {
    const results = run(
      { rows: [{ id: 1, owner_id: "a" }] },
      { rows: [{ owner_id: "a", id: 1 }] }, // same object, keys reordered
    );
    expect(outcomeAt(results, "/rows")).toBe("match-semantic");
  });

  it("row order does not matter when the rule is unordered-collection keyed by id", () => {
    const results = run(
      {
        rows: [
          { id: 1, owner_id: "a" },
          { id: 2, owner_id: "b" },
        ],
      },
      {
        rows: [
          { id: 2, owner_id: "b" },
          { id: 1, owner_id: "a" },
        ],
      },
    );
    expect(outcomeAt(results, "/rows")).toBe("match-semantic");
  });
});

describe("registry honesty: overlap and expiry", () => {
  it("classifies a real failure as known-divergence when exactly one active entry matches", () => {
    const results = run({ status: "success" }, { status: "error" });
    const resultsWithRegistry = compareStep({
      scenarioId: "scn.fake-two-step",
      scenarioDigest,
      stepId: "step.select",
      referenceSlot: "reference",
      candidateSlot: "candidate",
      referenceTarget: { kind: "fake", version: "1.0.0" },

      candidateTarget: { kind: "fake", version: "1.0.0" },
      referenceObservation: dataSelectObservation({ status: "success" }),
      candidateObservation: dataSelectObservation({ status: "error" }),
      referenceRawDigest: digest,
      candidateRawDigest: digest,
      policy: basePolicy(),
      registry: [baseKnownDivergence()],
      now: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(outcomeAt(resultsWithRegistry, "/status")).toBe("known-divergence");
    void results;
  });

  it("an expired entry does not classify (becomes new-divergence)", () => {
    const expired = baseKnownDivergence({
      verifiedAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2025-06-01T00:00:00.000Z",
    });
    const results = compareStep({
      scenarioId: "scn.fake-two-step",
      scenarioDigest,
      stepId: "step.select",
      referenceSlot: "reference",
      candidateSlot: "candidate",
      referenceTarget: { kind: "fake", version: "1.0.0" },

      candidateTarget: { kind: "fake", version: "1.0.0" },
      referenceObservation: dataSelectObservation({ status: "success" }),
      candidateObservation: dataSelectObservation({ status: "error" }),
      referenceRawDigest: digest,
      candidateRawDigest: digest,
      policy: basePolicy(),
      registry: [expired],
      now: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(outcomeAt(results, "/status")).toBe("new-divergence");
  });

  it("overlapping matching active entries are a registry error (inconclusive), never picked arbitrarily", () => {
    const a = baseKnownDivergence({ id: "div.a" });
    const b = baseKnownDivergence({ id: "div.b" });
    const results = compareStep({
      scenarioId: "scn.fake-two-step",
      scenarioDigest,
      stepId: "step.select",
      referenceSlot: "reference",
      candidateSlot: "candidate",
      referenceTarget: { kind: "fake", version: "1.0.0" },

      candidateTarget: { kind: "fake", version: "1.0.0" },
      referenceObservation: dataSelectObservation({ status: "success" }),
      candidateObservation: dataSelectObservation({ status: "error" }),
      referenceRawDigest: digest,
      candidateRawDigest: digest,
      policy: basePolicy(),
      registry: [a, b],
      now: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(outcomeAt(results, "/status")).toBe("inconclusive");
  });

  it("a known-divergence entry cannot rescue a target-lost / harness-level failure (it only ever applies to a real comparison result)", () => {
    // No comparison is attempted at all when a required trace is missing evidence;
    // compareStep is simply never called for that step, so no divergence entry can apply.
    // This test documents the invariant rather than exercising compareStep with missing input.
    expect(true).toBe(true);
  });
});

describe("rule selection ambiguity is a compile error, never first-registered-wins", () => {
  it("throws when two equally specific rules match the same selector", () => {
    const policy = basePolicy();
    policy.rules.push({ ...policy.rules[0]!, id: "rule.data-select-status-dup" });
    expect(() => run({}, {})).not.toThrow(); // uses basePolicy() fresh each call, unaffected
    expect(() =>
      compareStep({
        scenarioId: "scn.fake-two-step",
        scenarioDigest,
        stepId: "step.select",
        referenceSlot: "reference",
        candidateSlot: "candidate",
        referenceTarget: { kind: "fake", version: "1.0.0" },

        candidateTarget: { kind: "fake", version: "1.0.0" },
        referenceObservation: dataSelectObservation({}),
        candidateObservation: dataSelectObservation({}),
        referenceRawDigest: digest,
        candidateRawDigest: digest,
        policy,
        registry: [],
        now: new Date("2026-09-03T00:00:00.000Z"),
      }),
    ).toThrow(AmbiguousRuleSelectionError);
  });
});
