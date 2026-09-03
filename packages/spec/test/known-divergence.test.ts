import { describe, expect, it } from "vitest";
import { parseKnownDivergence, SpecValidationError } from "../src/index.js";
import type { KnownDivergence } from "../src/index.js";

function baseEntry(): KnownDivergence {
  return {
    format: "supadiff.known-divergence",
    formatVersion: "1.0",
    id: "div.sqlite-rls-with-check-subquery",
    title: "SQLite RLS WITH CHECK subqueries are unsupported",
    status: "active",
    referenceSelector: { kind: "supabase-local" },
    candidateSelector: { kind: "supalite-sqlite" },
    scenarioSelector: { scenarioId: "scn.rls-insert" },
    stepSelector: { stepId: "data.insert.todo" },
    observableSelector: "/status",
    rule: { id: "rule.insert-authorized", version: "1" },
    expectedFailure: { predicate: { op: "eq", left: "/status", right: { literal: 403 } } },
    rationale: "GT §2.5: SQLite RLS lacks WITH CHECK subquery support.",
    evidence: [{ kind: "note", value: "Technical Ground Truth §2.5" }],
    verifiedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    owner: "cesarmanzocode",
  };
}

describe("parseKnownDivergence", () => {
  it("accepts a valid entry", () => {
    expect(parseKnownDivergence(baseEntry() as never).id).toBe(
      "div.sqlite-rls-with-check-subquery",
    );
  });

  it("rejects a wildcard observable selector", () => {
    const e = baseEntry();
    (e as unknown as { observableSelector: string }).observableSelector = "*";
    expect(() => parseKnownDivergence(e as never)).toThrow(SpecValidationError);
  });

  it("rejects a wildcard version range on a selector", () => {
    const e = baseEntry();
    e.referenceSelector.versionRange = "*";
    expect(() => parseKnownDivergence(e as never)).toThrow(SpecValidationError);
  });

  it("rejects expiresAt not after verifiedAt", () => {
    const e = baseEntry();
    e.expiresAt = e.verifiedAt;
    expect(() => parseKnownDivergence(e as never)).toThrow(SpecValidationError);
  });

  it("rejects missing required evidence", () => {
    const e = baseEntry();
    (e as unknown as { evidence: unknown[] }).evidence = [];
    expect(() => parseKnownDivergence(e as never)).toThrow();
  });
});
