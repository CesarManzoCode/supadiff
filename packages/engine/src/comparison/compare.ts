import type {
  ComparisonOutcome,
  ComparisonPolicy,
  ComparisonResult,
  JsonPointer,
  JsonValue,
  KnownDivergence,
  Sha256,
  SemanticObservation,
  StableId,
} from "@supadiff/spec";
import { evaluateRule } from "./rule-engine.js";
import { selectRule } from "./select-rule.js";
import { matchKnownDivergence } from "./divergence-registry.js";
import type { TargetSelectionIdentity } from "./target-selector.js";
import { pointerMapToTree } from "../values/json-pointer.js";

export interface CompareStepInput {
  scenarioId: StableId;
  scenarioDigest: Sha256;
  /** Author-controlled scenario revision, checked against a divergence entry's `revisionRange` (§2.12). */
  scenarioRevision?: string;
  stepId: StableId;
  referenceSlot: StableId;
  candidateSlot: StableId;
  /** Full target identity (kind, backend, version) used for rule and divergence selection (§7.2, §2.12). */
  referenceTarget: TargetSelectionIdentity;
  candidateTarget: TargetSelectionIdentity;
  referenceObservation: SemanticObservation;
  candidateObservation: SemanticObservation;
  referenceRawDigest: Sha256;
  candidateRawDigest: Sha256;
  policy: ComparisonPolicy;
  registry: readonly KnownDivergence[];
  now: Date;
  /**
   * Capability ids resolved (declared+probed, already gated by the requirement's `accept`
   * list — §2.8) to something other than `unsupported` for this comparison. Drives rule and
   * divergence selection of capability-scoped entries; never inferred from error text.
   */
  resolvedCapabilities?: ReadonlySet<StableId>;
  /**
   * Resolved capability level per capability id, restricted to levels a requirement actually
   * accepted (i.e. already the output of `resolveCapability`'s `satisfied`/`accepted-approximation`
   * gate). Used only to decide `accepted-approximation` vs `match-*` after a rule already matched
   * — never to select which rule applies.
   */
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
  const resolvedCapabilities = input.resolvedCapabilities ?? new Set<StableId>();

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
      reference: input.referenceTarget,
      candidate: input.candidateTarget,
      resolvedCapabilities,
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

    const outcome = classifyOutcome(input, rule, explanation.verdict, path, explanation);
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
      explanation: outcome.explanation ?? explanation,
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
  explanation: ComparisonResult["explanation"],
): {
  outcome: ComparisonOutcome;
  divergenceId?: StableId;
  explanation?: ComparisonResult["explanation"];
} {
  if (verdict === "not-applicable") return { outcome: "match-semantic" };

  const capabilityId = rule.selector.capabilityContext;
  const capLevel = capabilityId ? input.capabilityLevels?.[capabilityId] : undefined;

  if (verdict === "satisfied") {
    // Accepted-approximation requires BOTH the rule to be satisfied under a capability-scoped
    // policy AND the resolved capability level to genuinely be approximation/experimental —
    // never awarded merely because some rule happened to match (§8, workstream 3).
    if (capLevel === "approximation" || capLevel === "experimental") {
      return { outcome: "accepted-approximation" };
    }
    if (rule.rule.kind === "exact") return { outcome: "match-exact" };
    return { outcome: "match-semantic" };
  }

  // verdict === "failed"
  const failureFacts: Record<string, JsonValue> = {
    reference: pointerMapToTree(input.referenceObservation.contractFields) as JsonValue,
    candidate: pointerMapToTree(input.candidateObservation.contractFields) as JsonValue,
  };
  const match = matchKnownDivergence(input.registry, {
    reference: input.referenceTarget,
    candidate: input.candidateTarget,
    scenarioId: input.scenarioId,
    scenarioRevision: input.scenarioRevision,
    stepId: input.stepId,
    observablePath: path,
    ruleId: rule.id,
    ruleVersion: rule.version,
    capability: capabilityId,
    failureFacts,
    now: input.now,
  });
  if (match.status === "matched")
    return { outcome: "known-divergence", divergenceId: match.entry.id };
  if (match.status === "ambiguous") return { outcome: "inconclusive" };
  if (match.status === "expired") {
    // Expired entries never classify; they produce new-divergence plus an explicit
    // expired-registry-entry diagnostic until revalidated (§2.12).
    return {
      outcome: "new-divergence",
      explanation: {
        ...explanation,
        transformations: [
          ...explanation.transformations,
          {
            kind: "expired-registry-entry",
            description: `registry entry "${match.entry.id}" structurally matched but expired at ${match.entry.expiresAt}; treated as new-divergence pending revalidation`,
          },
        ],
      },
    };
  }
  return { outcome: "new-divergence" };
}
