import type { Sha256, StableId } from "../ids.js";
import type { JsonObject, JsonPointer } from "../json-value.js";
import type { EvidenceRef } from "../capability/types.js";

export interface TargetSelector {
  kind: string; // TargetKind, kept as string here to avoid a spec<->target import cycle at this layer
  backend?: string;
  versionRange?: string;
}

export type ClaimRule =
  | { claim: string; predicate: "equals"; value: string | number | boolean }
  | { claim: string; predicate: "present" }
  | { claim: string; predicate: "absent" };

export type PredicateAst =
  | { op: "eq"; left: JsonPointer; right: JsonPointer | { literal: unknown } }
  | { op: "neq"; left: JsonPointer; right: JsonPointer | { literal: unknown } }
  | { op: "in"; left: JsonPointer; right: unknown[] }
  | { op: "and"; clauses: PredicateAst[] }
  | { op: "or"; clauses: PredicateAst[] }
  | { op: "not"; clause: PredicateAst };

export interface RedemptionContract {
  expectStatusCategory: "success" | "expired" | "forbidden";
  bytesMustMatch: boolean;
}

export interface DeltaContract {
  expectedChangedPaths: JsonPointer[];
  expectedUnchangedPaths: JsonPointer[];
}

/** The closed v1 rule algebra (§7.1). */
export type RuleExpression =
  | { kind: "exact" }
  | { kind: "object"; fields: FieldRule[]; unknown: "fail" }
  | { kind: "ordered-collection"; item: RuleExpression }
  | { kind: "unordered-collection"; item: RuleExpression; key?: JsonPointer }
  | { kind: "subset"; expectedSide: "reference" | "candidate"; item: RuleExpression }
  | { kind: "error-category"; taxonomy: { id: StableId; version: string } }
  | { kind: "relationship"; predicate: StableId }
  | { kind: "invariant"; predicate: PredicateAst }
  | { kind: "token-claims"; claims: ClaimRule[] }
  | { kind: "temporal-invariant"; expression: PredicateAst }
  | { kind: "url-redemption"; expected: RedemptionContract }
  | { kind: "state-readback"; before: JsonPointer; after: JsonPointer; delta: DeltaContract }
  | { kind: "explicit-ignore"; reason: string; evidence: EvidenceRef[] };

export interface FieldRule {
  field: JsonPointer;
  rule: RuleExpression;
}

export interface RuleSelector {
  service: string;
  operationId: StableId;
  operationVersion: string;
  observablePath: JsonPointer;
  referenceTargetSelector: TargetSelector;
  candidateTargetSelector: TargetSelector;
  capabilityContext?: StableId;
}

export interface ComparisonRule {
  id: StableId;
  version: string;
  selector: RuleSelector;
  inputType: string;
  rule: RuleExpression;
  strictness: "contract" | "diagnostic";
  rationale: string;
  evidence: EvidenceRef[];
}

export interface ComparisonPolicy {
  format: "supadiff.comparison-policy";
  formatVersion: "1.0";
  policyId: StableId;
  policyVersion: string;
  rules: ComparisonRule[];
}

export type ComparisonOutcome =
  | "match-exact"
  | "match-semantic"
  | "accepted-approximation"
  | "unsupported"
  | "known-divergence"
  | "new-divergence"
  | "inconclusive";

export interface TransformationReceipt {
  kind: string;
  description: string;
}

export interface ExplanationNode {
  rule: { id: StableId; version: string };
  path: JsonPointer;
  verdict: "satisfied" | "failed" | "not-applicable";
  summary: string;
  inputDigests: { reference: Sha256; candidate: Sha256 };
  transformations: TransformationReceipt[];
  children?: ExplanationNode[];
}

export interface EvidencePointer {
  targetSlot: StableId;
  observationDigest: Sha256;
}

export interface ComparisonResult {
  resultId: StableId;
  targetPair: [StableId, StableId];
  scenarioDigest: Sha256;
  stepId: StableId;
  observablePath: JsonPointer;
  rule: { id: StableId; version: string };
  outcome: ComparisonOutcome;
  reference: EvidencePointer;
  candidate: EvidencePointer;
  explanation: ExplanationNode;
  divergenceId?: StableId;
  approximationId?: StableId;
}

export type { JsonObject };
