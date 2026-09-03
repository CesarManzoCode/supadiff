import type {
  ComparisonOutcome,
  ComparisonPolicy,
  ComparisonResult,
  JsonPointer,
  KnownDivergence,
  Sha256,
  SemanticObservation,
  StableId,
} from "@supadiff/spec";
import { evaluateRule } from "./rule-engine.js";
import { selectRule } from "./select-rule.js";
import { matchKnownDivergence } from "./divergence-registry.js";

export interface CompareStepInput {
  scenarioId: StableId;
  scenarioDigest: Sha256;
  stepId: StableId;
  referenceSlot: StableId;
  candidateSlot: StableId;
  referenceTargetKind: string;
  candidateTargetKind: string;
  referenceObservation: SemanticObservation;
  candidateObservation: SemanticObservation;
  referenceRawDigest: Sha256;
  candidateRawDigest: Sha256;
  policy: ComparisonPolicy;
  registry: readonly KnownDivergence[];
  now: Date;
  /** Resolved capability level per capability id, when the selected rule pins one (§8.1). */
  capabilityLevels?: Record<StableId, "exact" | "approximation" | "experimental" | "unsupported">;
}

function allObservablePaths(a: SemanticObservation, b: SemanticObservation): JsonPointer[] {
  return [...new Set([...Object.keys(a.contractFields), ...Object.keys(b.contractFields)])];
}

export function compareStep(input: CompareStepInput): ComparisonResult[] {
  const results: ComparisonResult[] = [];
  const evidence = {
    reference: { targetSlot: input.referenceSlot, observationDigest: input.referenceRawDigest },
    candidate: { targetSlot: input.candidateSlot, observationDigest: input.candidateRawDigest },
  };

  // Unassessed fields on either side are inconclusive on their own right (fail closed, §7.3).
  const unassessed = new Set([
    ...input.referenceObservation.coverage.unassessedFields,
    ...input.candidateObservation.coverage.unassessedFields,
  ]);
  for (const path of unassessed) {
    results.push({
      resultId: `res-${input.stepId}-${path}-unassessed`,
      targetPair: [input.referenceSlot, input.candidateSlot],
      scenarioDigest: input.scenarioDigest,
      stepId: input.stepId,
      observablePath: path,
      rule: { id: "inconclusive.unassessed-field", version: "1" },
      outcome: "inconclusive",
      reference: evidence.reference,
      candidate: evidence.candidate,
      explanation: {
        rule: { id: "inconclusive.unassessed-field", version: "1" },
        path,
        verdict: "not-applicable",
        summary:
          "a raw field was not accounted for by any contractual, diagnostic, or explicit-ignore mapping",
        inputDigests: { reference: input.referenceRawDigest, candidate: input.candidateRawDigest },
        transformations: [],
      },
    });
  }

  for (const path of allObservablePaths(input.referenceObservation, input.candidateObservation)) {
    const service = input.referenceObservation.service;
    const rule = selectRule(input.policy, {
      service,
      operationId: input.referenceObservation.operation.id,
      operationVersion: input.referenceObservation.operation.version,
      observablePath: path,
      referenceTargetKind: input.referenceTargetKind,
      candidateTargetKind: input.candidateTargetKind,
    });

    if (!rule) {
      results.push(
        inconclusiveResult(
          input,
          path,
          evidence,
          "no comparison rule is registered for this observable path",
        ),
      );
      continue;
    }

    const explanation = evaluateRule(rule.rule, {
      ruleRef: { id: rule.id, version: rule.version },
      path,
      referenceValue: input.referenceObservation.contractFields[path],
      candidateValue: input.candidateObservation.contractFields[path],
      referenceObservation: input.referenceObservation,
      candidateObservation: input.candidateObservation,
    });

    const outcome = classifyOutcome(input, rule, explanation.verdict, path);
    results.push({
      resultId: `res-${input.stepId}-${path}`,
      targetPair: [input.referenceSlot, input.candidateSlot],
      scenarioDigest: input.scenarioDigest,
      stepId: input.stepId,
      observablePath: path,
      rule: { id: rule.id, version: rule.version },
      outcome: outcome.outcome,
      reference: evidence.reference,
      candidate: evidence.candidate,
      explanation,
      ...(outcome.divergenceId ? { divergenceId: outcome.divergenceId } : {}),
    });
  }

  return results;
}

function inconclusiveResult(
  input: CompareStepInput,
  path: JsonPointer,
  evidence: { reference: ComparisonResult["reference"]; candidate: ComparisonResult["candidate"] },
  reason: string,
): ComparisonResult {
  return {
    resultId: `res-${input.stepId}-${path}-no-rule`,
    targetPair: [input.referenceSlot, input.candidateSlot],
    scenarioDigest: input.scenarioDigest,
    stepId: input.stepId,
    observablePath: path,
    rule: { id: "inconclusive.no-rule", version: "1" },
    outcome: "inconclusive",
    reference: evidence.reference,
    candidate: evidence.candidate,
    explanation: {
      rule: { id: "inconclusive.no-rule", version: "1" },
      path,
      verdict: "not-applicable",
      summary: reason,
      inputDigests: { reference: input.referenceRawDigest, candidate: input.candidateRawDigest },
      transformations: [],
    },
  };
}

function classifyOutcome(
  input: CompareStepInput,
  rule: ComparisonPolicy["rules"][number],
  verdict: "satisfied" | "failed" | "not-applicable",
  path: JsonPointer,
): { outcome: ComparisonOutcome; divergenceId?: StableId } {
  if (verdict === "not-applicable") return { outcome: "match-semantic" };

  if (verdict === "satisfied") {
    const capLevel = input.capabilityLevels?.[rule.selector.capabilityContext ?? ""];
    if (capLevel === "approximation" || capLevel === "experimental") {
      return { outcome: "accepted-approximation" };
    }
    if (rule.rule.kind === "exact") return { outcome: "match-exact" };
    return { outcome: "match-semantic" };
  }

  // verdict === "failed"
  const match = matchKnownDivergence(input.registry, {
    referenceKind: input.referenceTargetKind,
    candidateKind: input.candidateTargetKind,
    scenarioId: input.scenarioId,
    stepId: input.stepId,
    observablePath: path,
    ruleId: rule.id,
    ruleVersion: rule.version,
    now: input.now,
  });
  if (match.status === "matched")
    return { outcome: "known-divergence", divergenceId: match.entry.id };
  if (match.status === "ambiguous") return { outcome: "inconclusive" };
  return { outcome: "new-divergence" };
}
