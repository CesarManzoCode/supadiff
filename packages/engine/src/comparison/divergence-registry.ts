import type { JsonPointer, KnownDivergence, StableId } from "@supadiff/spec";

export interface DivergenceMatchContext {
  referenceKind: string;
  candidateKind: string;
  scenarioId: StableId;
  stepId: StableId;
  observablePath: JsonPointer;
  ruleId: StableId;
  ruleVersion: string;
  now: Date;
}

export type DivergenceMatchResult =
  | { status: "none" }
  | { status: "matched"; entry: KnownDivergence }
  | { status: "ambiguous"; entries: KnownDivergence[] }
  | { status: "expired"; entry: KnownDivergence };

function isCandidate(entry: KnownDivergence, ctx: DivergenceMatchContext): boolean {
  return (
    entry.status === "active" &&
    entry.referenceSelector.kind === ctx.referenceKind &&
    entry.candidateSelector.kind === ctx.candidateKind &&
    entry.scenarioSelector.scenarioId === ctx.scenarioId &&
    entry.stepSelector.stepId === ctx.stepId &&
    entry.observableSelector === ctx.observablePath &&
    entry.rule.id === ctx.ruleId &&
    entry.rule.version === ctx.ruleVersion
  );
}

/**
 * Matches a failed comparison against the known-divergence registry (§2.12, §8.2).
 * All selectors and the failure signature must match exactly. Expired entries never
 * classify. Multiple matching active entries is a registry error (`ambiguous`), not a
 * silent pick — it must never convert a real failure into a pass.
 */
export function matchKnownDivergence(
  registry: readonly KnownDivergence[],
  ctx: DivergenceMatchContext,
): DivergenceMatchResult {
  const structurallyMatching = registry.filter((e) => isCandidate(e, ctx));
  if (structurallyMatching.length === 0) return { status: "none" };

  const nonExpired = structurallyMatching.filter(
    (e) => ctx.now.getTime() < Date.parse(e.expiresAt),
  );
  if (nonExpired.length === 0) return { status: "expired", entry: structurallyMatching[0]! };
  if (nonExpired.length > 1) return { status: "ambiguous", entries: nonExpired };
  return { status: "matched", entry: nonExpired[0]! };
}
