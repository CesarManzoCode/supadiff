import type { ComparisonPolicy, KnownDivergence, SemanticObservation } from "@supadiff/spec";

export function dataSelectObservation(overrides: {
  status?: string;
  rows?: unknown[];
  ordered?: boolean;
  unassessed?: string[];
}): SemanticObservation {
  return {
    format: "supadiff.semantic-observation",
    projector: { id: "data.select", version: "1" },
    sourceRawDigest: `sha256:${"1".repeat(64)}`,
    service: "data",
    operation: { id: "data.select", version: "1" },
    contractFields: {
      "/status": overrides.status ?? "success",
      "/rows": (overrides.rows ?? [{ id: 1, owner_id: "owner-abc" }]) as never,
    },
    ignoredFields: [],
    relationships: [],
    stateFacts: [{ label: "ordered", value: overrides.ordered ?? true }],
    coverage: {
      contractualFields: ["/status", "/rows"],
      diagnosticFields: [],
      ignoredFields: ["/count"],
      unassessedFields: overrides.unassessed ?? [],
    },
  };
}

export function basePolicy(): ComparisonPolicy {
  return {
    format: "supadiff.comparison-policy",
    formatVersion: "1.0",
    policyId: "policy.fake",
    policyVersion: "1",
    rules: [
      {
        id: "rule.data-select-status",
        version: "1",
        selector: {
          service: "data",
          operationId: "data.select",
          operationVersion: "1",
          observablePath: "/status",
          referenceTargetSelector: { kind: "fake" },
          candidateTargetSelector: { kind: "fake" },
        },
        inputType: "string",
        rule: { kind: "exact" },
        strictness: "contract",
        rationale: "status must match exactly",
        evidence: [{ kind: "note", value: "contract" }],
      },
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
        rule: {
          kind: "unordered-collection",
          item: {
            kind: "object",
            unknown: "fail",
            fields: [
              { field: "/id", rule: { kind: "exact" } },
              { field: "/owner_id", rule: { kind: "exact" } },
            ],
          },
          key: "/id",
        },
        strictness: "contract",
        rationale: "rows are keyed by id and compared without regard to order unless requested",
        evidence: [{ kind: "note", value: "contract §7.3" }],
      },
    ],
  };
}

export function baseKnownDivergence(overrides: Partial<KnownDivergence> = {}): KnownDivergence {
  return {
    format: "supadiff.known-divergence",
    formatVersion: "1.0",
    id: "div.status-mismatch",
    title: "SQLite returns a different status category",
    status: "active",
    referenceSelector: { kind: "fake" },
    candidateSelector: { kind: "fake" },
    scenarioSelector: { scenarioId: "scn.fake-two-step" },
    stepSelector: { stepId: "step.select" },
    observableSelector: "/status",
    rule: { id: "rule.data-select-status", version: "1" },
    expectedFailure: {
      predicate: { op: "eq", left: "/reference/status", right: { literal: "success" } },
    },
    rationale: "known backend limitation",
    evidence: [{ kind: "note", value: "GT §2.3" }],
    verifiedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    owner: "cesarmanzocode",
    ...overrides,
  };
}
