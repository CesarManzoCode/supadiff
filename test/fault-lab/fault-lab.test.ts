import { describe, expect, it } from "vitest";
import {
  FakeTargetDriver,
  runScenario,
  compareStep,
  buildDivergenceSignatures,
  type TargetHandle,
} from "@supadiff/engine";
import { computeScenarioDigest, sha256OfCanonicalJson } from "@supadiff/spec";
import { FAULT_DEFINITIONS, FAULT_LAB_POLICY } from "./fixtures.js";

function targetSpecFor(slot: string) {
  return {
    id: slot,
    kind: "fake" as const,
    runtime: { runtime: "node", version: process.version },
    config: { scriptId: slot },
    credentialRefs: [],
    lifecycle: {
      allocation: "provision-new" as const,
      isolation: "fresh-instance" as const,
      readinessTimeoutMs: 2000,
      teardownTimeoutMs: 2000,
      cleanup: "always" as const,
      keepOnFailure: "deny" as const,
    },
    safety: {
      allowHosted: false,
      allowHostedCreate: false,
      allowHostedDestructive: false,
      maxHostedCostUsd: 0,
    },
  };
}

describe("L9 dogfood fault lab (§15.5)", () => {
  for (const fault of FAULT_DEFINITIONS) {
    it(`detects and explains "${fault.id}"`, async () => {
      const driver = new FakeTargetDriver({
        reference: fault.referenceScript,
        faulty: fault.faultyScript,
      });
      const handles: TargetHandle[] = [
        { slot: "reference", spec: targetSpecFor("reference"), driver },
        { slot: "faulty", spec: targetSpecFor("faulty"), driver },
      ];
      const result = await runScenario(fault.scenario, handles, { policy: FAULT_LAB_POLICY });
      expect(result.state).toBe("complete");

      const ref = result.targets.get("reference")!;
      const cand = result.targets.get("faulty")!;
      const refObs = ref.semanticObservations.get("step.probe:1")!;
      const candObs = cand.semanticObservations.get("step.probe:1")!;
      const scenarioDigest = computeScenarioDigest(fault.scenario);

      const results = compareStep({
        scenarioId: fault.scenario.id,
        scenarioDigest,
        scenarioRevision: fault.scenario.revision,
        stepId: "step.probe",
        referenceSlot: "reference",
        candidateSlot: "faulty",
        referenceTarget: { kind: "fake", version: "1.0.0" },
        candidateTarget: { kind: "fake", version: "1.0.0" },
        referenceObservation: refObs,
        candidateObservation: candObs,
        referenceRawDigest: sha256OfCanonicalJson(ref.rawObservations.get("step.probe:1") as never),
        candidateRawDigest: sha256OfCanonicalJson(
          cand.rawObservations.get("step.probe:1") as never,
        ),
        policy: FAULT_LAB_POLICY,
        registry: [],
        now: new Date(),
      });

      const atPath = results.find((r) => r.observablePath === fault.observablePath);
      expect(atPath, `expected a comparison result at ${fault.observablePath}`).toBeDefined();
      expect(atPath!.outcome).toBe("new-divergence");
      expect(atPath!.explanation.verdict).toBe("failed");
      expect(atPath!.explanation.summary.length).toBeGreaterThan(0);

      const signatures = buildDivergenceSignatures(fault.scenario, results, "fake", "fake");
      expect(signatures.some((s) => s.observablePath === fault.observablePath)).toBe(true);
    });

    it(`benign counterpart matches for "${fault.id}"`, async () => {
      const driver = new FakeTargetDriver({
        reference: fault.referenceScript,
        benign: fault.benignScript,
      });
      const handles: TargetHandle[] = [
        { slot: "reference", spec: targetSpecFor("reference"), driver },
        { slot: "benign", spec: targetSpecFor("benign"), driver },
      ];
      const result = await runScenario(fault.scenario, handles, { policy: FAULT_LAB_POLICY });
      expect(result.state).toBe("complete");

      const ref = result.targets.get("reference")!;
      const cand = result.targets.get("benign")!;
      const refObs = ref.semanticObservations.get("step.probe:1")!;
      const candObs = cand.semanticObservations.get("step.probe:1")!;
      const scenarioDigest = computeScenarioDigest(fault.scenario);

      const results = compareStep({
        scenarioId: fault.scenario.id,
        scenarioDigest,
        scenarioRevision: fault.scenario.revision,
        stepId: "step.probe",
        referenceSlot: "reference",
        candidateSlot: "benign",
        referenceTarget: { kind: "fake", version: "1.0.0" },
        candidateTarget: { kind: "fake", version: "1.0.0" },
        referenceObservation: refObs,
        candidateObservation: candObs,
        referenceRawDigest: sha256OfCanonicalJson(ref.rawObservations.get("step.probe:1") as never),
        candidateRawDigest: sha256OfCanonicalJson(
          cand.rawObservations.get("step.probe:1") as never,
        ),
        policy: FAULT_LAB_POLICY,
        registry: [],
        now: new Date(),
      });

      const atPath = results.find((r) => r.observablePath === fault.observablePath);
      expect(atPath, `expected a comparison result at ${fault.observablePath}`).toBeDefined();
      expect(["match-exact", "match-semantic"]).toContain(atPath!.outcome);
      for (const r of results) {
        expect(r.outcome, `path ${r.observablePath} should not be a new/known divergence`).not.toBe(
          "new-divergence",
        );
      }
    });
  }
});
