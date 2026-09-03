import semver from "semver";
import type { JsonValue, KnownDivergence, StableId } from "@supadiff/spec";
import { targetSelectorMatches, type TargetSelectionIdentity } from "./target-selector.js";
import { evaluatePredicate } from "./predicate.js";

export interface DivergenceMatchContext {
  reference: TargetSelectionIdentity;
  candidate: TargetSelectionIdentity;
  scenarioId: StableId;
  /** Author-controlled scenario revision, checked against `scenarioSelector.revisionRange` when declared. */
  scenarioRevision?: string;
  stepId: StableId;
  observablePath: string;
  ruleId: StableId;
  ruleVersion: string;
  /** Capability id resolved for this comparison, when the failing rule was capability-scoped. */
  capability?: StableId;
  /**
   * The real observed failure facts, shaped `{ reference: {...}, candidate: {...} }` over
   * each side's contract fields — the same shape `invariant`/`temporal-invariant` rules
   * evaluate against. `expectedFailure` is evaluated against these, never against error
   * message text (§2.12: "An entry cannot match solely on error text").
   */
  failureFacts: Record<string, JsonValue>;
  now: Date;
}

export type DivergenceMatchResult =
  | { status: "none" }
  | { status: "matched"; entry: KnownDivergence }
  | { status: "ambiguous"; entries: KnownDivergence[] }
  | { status: "expired"; entry: KnownDivergence };

function scenarioMatches(entry: KnownDivergence, ctx: DivergenceMatchContext): boolean {
  if (entry.scenarioSelector.scenarioId !== ctx.scenarioId) return false;
  if (entry.scenarioSelector.revisionRange === undefined) return true;
  if (ctx.scenarioRevision === undefined) return false;
  // Scenario revisions are author-controlled semantic revisions, not necessarily semver —
  // fall back to exact string equality when the declared range isn't a parseable semver
  // range so an unparsable range fails closed rather than matching everything.
  if (semver.validRange(entry.scenarioSelector.revisionRange)) {
    return (
      semver.valid(ctx.scenarioRevision) !== null &&
      semver.satisfies(ctx.scenarioRevision, entry.scenarioSelector.revisionRange, {
        includePrerelease: true,
      })
    );
  }
  // An unparsable declared range falls back to exact string equality rather than
  // matching everything, so a malformed registry entry fails closed, not open.
  return ctx.scenarioRevision === entry.scenarioSelector.revisionRange;
}

function isStructuralCandidate(entry: KnownDivergence, ctx: DivergenceMatchContext): boolean {
  return (
    entry.status === "active" &&
    targetSelectorMatches(entry.referenceSelector, ctx.reference) &&
    targetSelectorMatches(entry.candidateSelector, ctx.candidate) &&
    scenarioMatches(entry, ctx) &&
    entry.stepSelector.stepId === ctx.stepId &&
    entry.observableSelector === ctx.observablePath &&
    entry.rule.id === ctx.ruleId &&
    entry.rule.version === ctx.ruleVersion &&
    (entry.capability === undefined || entry.capability === ctx.capability)
  );
}

/**
 * Matches a failed comparison against the known-divergence registry (§2.12, §8.2).
 * A match requires ALL of: reference/candidate target selector (kind, backend, bounded
 * version), scenario selector, step selector, observable path, rule id/version, capability
 * (when declared), `status === "active"`, non-expiry, AND `expectedFailure` evaluated true
 * against the real observed failure facts — never against error text alone. Multiple
 * matching active entries is a registry error (`ambiguous`), never resolved by a silent
 * pick, and can never convert a real failure into a pass. Expired entries never classify.
 */
export function matchKnownDivergence(
  registry: readonly KnownDivergence[],
  ctx: DivergenceMatchContext,
): DivergenceMatchResult {
  const structurallyMatching = registry.filter((e) => isStructuralCandidate(e, ctx));
  if (structurallyMatching.length === 0) return { status: "none" };

  const nonExpired = structurallyMatching.filter(
    (e) => ctx.now.getTime() < Date.parse(e.expiresAt),
  );
  if (nonExpired.length === 0) return { status: "expired", entry: structurallyMatching[0]! };

  const predicateMatching = nonExpired.filter((e) =>
    evaluatePredicate(e.expectedFailure.predicate, ctx.failureFacts),
  );
  if (predicateMatching.length === 0) return { status: "none" };
  if (predicateMatching.length > 1) return { status: "ambiguous", entries: predicateMatching };
  return { status: "matched", entry: predicateMatching[0]! };
}
