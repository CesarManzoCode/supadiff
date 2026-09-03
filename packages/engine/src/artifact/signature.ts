import {
  sha256OfCanonicalJson,
  type ComparisonResult,
  type DivergenceSignature,
  type JsonValue,
  type ScenarioSpec,
} from "@supadiff/spec";

/**
 * Builds a portable `DivergenceSignature` for every non-matching comparison outcome
 * (§9.3). Excludes wall time, run nonce, ports, workdirs, and raw token bytes by
 * construction — it is derived only from the rule/path/outcome identity.
 */
export function buildDivergenceSignatures(
  scenario: ScenarioSpec,
  results: ComparisonResult[],
  referenceKind: string,
  candidateKind: string,
): DivergenceSignature[] {
  return results
    .filter((r) => r.outcome === "known-divergence" || r.outcome === "new-divergence")
    .map((r) => {
      const step = scenario.steps.find((s) => s.id === r.stepId);
      return {
        scenarioDigest: r.scenarioDigest,
        operationId: step?.kind ?? "unknown",
        operationVersion: "1",
        stepId: r.stepId,
        observablePath: r.observablePath,
        ruleId: r.rule.id,
        ruleVersion: r.rule.version,
        outcome: r.outcome,
        referenceSelector: { kind: referenceKind },
        candidateSelector: { kind: candidateKind },
        normalizedFailurePredicateDigest: sha256OfCanonicalJson({
          stepId: r.stepId,
          observablePath: r.observablePath,
          ruleId: r.rule.id,
        } as unknown as JsonValue),
      };
    });
}
