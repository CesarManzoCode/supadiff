import type { ComparisonPolicy, ComparisonRule, JsonPointer, StableId } from "@supadiff/spec";
import { targetSelectorMatches, type TargetSelectionIdentity } from "./target-selector.js";

export interface RuleMatchContext {
  service: string;
  operationId: StableId;
  operationVersion: string;
  observablePath: JsonPointer;
  reference: TargetSelectionIdentity;
  candidate: TargetSelectionIdentity;
  /**
   * Capability ids resolved (declared+probed, gated by the requirement's `accept` list —
   * §2.8) to something other than `unsupported` for this comparison. A rule scoped to a
   * capability outside this set MUST NOT be selected (§3 selection tests: "wrong capability
   * not selected"); selection never infers capability context from error-message strings.
   */
  resolvedCapabilities: ReadonlySet<StableId>;
}

export class AmbiguousRuleSelectionError extends Error {
  constructor(path: JsonPointer, candidates: ComparisonRule[]) {
    super(
      `ambiguous rule selection at "${path}": ${candidates.length} equally specific rules match (${candidates
        .map((r) => `${r.id}@${r.version}`)
        .join(", ")}) — a compile error per §7.2, never "first registered wins"`,
    );
    this.name = "AmbiguousRuleSelectionError";
  }
}

function matches(rule: ComparisonRule, ctx: RuleMatchContext): boolean {
  const s = rule.selector;
  if (s.service !== ctx.service) return false;
  if (s.operationId !== ctx.operationId) return false;
  if (s.operationVersion !== ctx.operationVersion) return false;
  if (s.observablePath !== ctx.observablePath) return false;
  if (!targetSelectorMatches(s.referenceTargetSelector, ctx.reference)) return false;
  if (!targetSelectorMatches(s.candidateTargetSelector, ctx.candidate)) return false;
  if (s.capabilityContext !== undefined && !ctx.resolvedCapabilities.has(s.capabilityContext)) {
    return false;
  }
  return true;
}

/** Higher score = more specific (§7.2: exact operation version, exact path, exact target, exact capability context). */
function specificity(rule: ComparisonRule): number {
  let score = 0;
  if (rule.selector.capabilityContext !== undefined) score += 1;
  if (rule.selector.referenceTargetSelector.backend !== undefined) score += 1;
  if (rule.selector.candidateTargetSelector.backend !== undefined) score += 1;
  if (rule.selector.referenceTargetSelector.versionRange !== undefined) score += 1;
  if (rule.selector.candidateTargetSelector.versionRange !== undefined) score += 1;
  return score;
}

/**
 * Selects the single most specific rule for one observable path (§7.2). Two equally
 * specific matching rules are a compile-time-equivalent error, never resolved by
 * registration order.
 */
export function selectRule(
  policy: ComparisonPolicy,
  ctx: RuleMatchContext,
): ComparisonRule | undefined {
  const candidates = policy.rules.filter((r) => matches(r, ctx));
  if (candidates.length === 0) return undefined;
  const maxScore = Math.max(...candidates.map(specificity));
  const winners = candidates.filter((r) => specificity(r) === maxScore);
  if (winners.length > 1) throw new AmbiguousRuleSelectionError(ctx.observablePath, winners);
  return winners[0];
}
