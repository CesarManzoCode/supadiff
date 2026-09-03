import {
  compareStep,
  buildDivergenceSignatures,
  buildBundle,
  runScenario,
  type BundleTargetRun,
  type TargetHandle,
} from "@supadiff/engine";
import {
  computeScenarioDigest,
  parseScenarioSpec,
  sha256OfCanonicalJson,
  canonicalizeJson,
  SpecValidationError,
  type ScenarioSpec,
} from "@supadiff/spec";
import type { AcceptanceOracle, AcceptanceOutcome, ReductionContext } from "./types.js";
import type { DivergenceSignature } from "@supadiff/spec";

/**
 * A `DivergenceSignature` deliberately contains "scenario digest OR REDUCED scenario
 * digest" (§9.3) — a reduced candidate's digest legitimately differs from the original's
 * every time a node is removed, precisely because the scenario bytes changed. "Same
 * divergence" for replay/reduction purposes therefore compares every OTHER signature
 * field exactly and never requires `scenarioDigest` equality on its own.
 */
function signatureIdentityDigest(sig: DivergenceSignature): string {
  const rest: Omit<DivergenceSignature, "scenarioDigest"> = {
    operationId: sig.operationId,
    operationVersion: sig.operationVersion,
    stepId: sig.stepId,
    observablePath: sig.observablePath,
    ruleId: sig.ruleId,
    ruleVersion: sig.ruleVersion,
    outcome: sig.outcome,
    referenceSelector: sig.referenceSelector,
    candidateSelector: sig.candidateSelector,
    normalizedFailurePredicateDigest: sig.normalizedFailurePredicateDigest,
  };
  return sha256OfCanonicalJson(rest as never);
}

/**
 * The real acceptance oracle (§11.2): a candidate is accepted only if it (1) statically
 * validates, (2) both fresh targets satisfy the same capability envelope, (3) the run
 * completes with no new unassessed field or harness failure, (4) the SAME divergence
 * signature reproduces, and (5) the resulting artifact passes the secret scan.
 */
export const runAcceptanceOracle: AcceptanceOracle = async (
  candidate: ScenarioSpec,
  ctx: ReductionContext,
): Promise<AcceptanceOutcome> => {
  let parsed: ScenarioSpec;
  try {
    parsed = parseScenarioSpec(JSON.parse(canonicalizeJson(candidate as never)));
  } catch (err) {
    if (err instanceof SpecValidationError) {
      return { accepted: false, reason: `static validation failed: ${err.message}` };
    }
    throw err;
  }

  const referenceDriver = ctx.buildDriver(ctx.referenceSpec, parsed.resources);
  const candidateDriver = ctx.buildDriver(ctx.candidateSpec, parsed.resources);
  const handles: TargetHandle[] = [
    { slot: ctx.referenceSpec.id, spec: ctx.referenceSpec, driver: referenceDriver },
    { slot: ctx.candidateSpec.id, spec: ctx.candidateSpec, driver: candidateDriver },
  ];

  const result = await runScenario(parsed, handles, { policy: ctx.policy });
  if (result.state === "unsupported") {
    return { accepted: false, reason: "capability envelope no longer satisfied by both targets" };
  }
  if (result.state !== "complete" && result.state !== "inconclusive-cleanup") {
    return { accepted: false, reason: `run did not complete (state: ${result.state})` };
  }

  const referenceRun = result.targets.get(ctx.referenceSpec.id)!;
  const candidateRun = result.targets.get(ctx.candidateSpec.id)!;
  for (const t of [referenceRun, candidateRun]) {
    if (t.redactionFailures.length > 0) {
      return { accepted: false, reason: "redaction failure on a fresh run" };
    }
  }

  const scenarioDigest = computeScenarioDigest(parsed);
  const comparisonResults = [];
  for (const step of parsed.steps) {
    const refObs = referenceRun.semanticObservations.get(`${step.id}:1`);
    const candObs = candidateRun.semanticObservations.get(`${step.id}:1`);
    if (!refObs || !candObs) continue;
    comparisonResults.push(
      ...compareStep({
        scenarioId: parsed.id,
        scenarioDigest,
        scenarioRevision: parsed.revision,
        stepId: step.id,
        referenceSlot: ctx.referenceSpec.id,
        candidateSlot: ctx.candidateSpec.id,
        referenceTarget: {
          kind: ctx.referenceSpec.kind,
          backend: referenceRun.identity?.backend?.backend,
          version: referenceRun.identity?.implementationVersion ?? "0.0.0",
        },
        candidateTarget: {
          kind: ctx.candidateSpec.kind,
          backend: candidateRun.identity?.backend?.backend,
          version: candidateRun.identity?.implementationVersion ?? "0.0.0",
        },
        referenceObservation: refObs,
        candidateObservation: candObs,
        referenceRawDigest: sha256OfCanonicalJson(
          referenceRun.rawObservations.get(`${step.id}:1`) as never,
        ),
        candidateRawDigest: sha256OfCanonicalJson(
          candidateRun.rawObservations.get(`${step.id}:1`) as never,
        ),
        policy: ctx.policy,
        registry: ctx.knownDivergences,
        now: new Date(),
      }),
    );
  }

  const unassessed = comparisonResults.filter((r) => r.rule.id === "inconclusive.unassessed-field");
  if (unassessed.length > 0) {
    return { accepted: false, reason: "candidate introduced a new unassessed-field result" };
  }

  const signatures = buildDivergenceSignatures(
    parsed,
    comparisonResults,
    ctx.referenceSpec.kind,
    ctx.candidateSpec.kind,
  );
  const reproduced = signatures.some(
    (s) => signatureIdentityDigest(s) === signatureIdentityDigest(ctx.expectedSignature),
  );
  if (!reproduced) {
    return { accepted: false, reason: "expected divergence signature did not reproduce" };
  }

  const bundleTargets: BundleTargetRun[] = [
    {
      slot: ctx.referenceSpec.id,
      role: "reference",
      targetSpec: ctx.referenceSpec,
      identity: referenceRun.identity,
      capabilities: referenceRun.probedCapabilities,
      events: referenceRun.events,
      rawObservations: referenceRun.rawObservations,
      semanticObservations: referenceRun.semanticObservations,
    },
    {
      slot: ctx.candidateSpec.id,
      role: "candidate",
      targetSpec: ctx.candidateSpec,
      identity: candidateRun.identity,
      capabilities: candidateRun.probedCapabilities,
      events: candidateRun.events,
      rawObservations: candidateRun.rawObservations,
      semanticObservations: candidateRun.semanticObservations,
    },
  ];
  const bundle = buildBundle({
    scenario: parsed,
    policy: ctx.policy,
    knownDivergences: ctx.knownDivergences,
    targets: bundleTargets,
    comparisonResults,
    divergenceSignatures: signatures,
    toolchain: { name: "supadiff", version: "0.1.0", node: process.version },
    recoverySummary: { leaks: [...referenceRun.recoveryLeaks, ...candidateRun.recoveryLeaks] },
    configuredSecretLiterals: [],
    createdAt: new Date().toISOString(),
  });
  if (!bundle.secretScanPassed) {
    return { accepted: false, reason: "candidate artifact failed the secret scan" };
  }

  return { accepted: true };
};
