import type { IsoDateTime, StableId } from "../ids.js";
import type { EvidenceRef } from "../capability/types.js";
import type { TargetSelector, PredicateAst } from "../comparison/types.js";

export interface ScenarioSelector {
  scenarioId: StableId;
  revisionRange?: string;
}

export interface StepSelector {
  stepId: StableId;
}

export interface FailurePredicate {
  predicate: PredicateAst;
}

export type KnownDivergenceStatus =
  | "active"
  | "fixed-pending-verification"
  | "resolved"
  | "wont-fix";

export interface KnownDivergence {
  format: "supadiff.known-divergence";
  formatVersion: "1.0";
  id: StableId;
  title: string;
  status: KnownDivergenceStatus;
  referenceSelector: TargetSelector;
  candidateSelector: TargetSelector;
  capability?: StableId;
  scenarioSelector: ScenarioSelector;
  stepSelector: StepSelector;
  observableSelector: string;
  rule: { id: StableId; version: string };
  expectedFailure: FailurePredicate;
  rationale: string;
  evidence: EvidenceRef[];
  upstream?: { url: string; issueOrPr?: string };
  introduced?: string;
  verifiedAt: IsoDateTime;
  expiresAt: IsoDateTime;
  owner: string;
}
