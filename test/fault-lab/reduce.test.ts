import { describe, expect, it } from "vitest";
import {
  FakeTargetDriver,
  runScenario,
  compareStep,
  buildDivergenceSignatures,
  type FakeScript,
  type TargetHandle,
} from "@supadiff/engine";
import {
  computeScenarioDigest,
  sha256OfCanonicalJson,
  type ComparisonPolicy,
  type ScenarioSpec,
  type TargetSpec,
} from "@supadiff/spec";
import { reduceArtifact, type ReductionContext } from "@supadiff/reducer";

function identity() {
  return {
    targetKind: "fake" as const,
    implementation: "fault-lab-reduce",
    implementationVersion: "1.0.0",
    runtime: { runtime: "node", version: process.version },
    clientVersion: "0.0.0",
    platform: { os: "linux", arch: "x64" },
    effectiveConfigDigest: `sha256:${"0".repeat(64)}`,
    observedAt: "2026-01-01T00:00:00.000Z",
  };
}

const CAPS = [
  {
    id: "data.select",
    version: "1.0.0",
    level: "exact" as const,
    constraints: {},
    evidence: [],
    observed: false,
  },
  {
    id: "data.insert",
    version: "1.0.0",
    level: "exact" as const,
    constraints: {},
    evidence: [],
    observed: false,
  },
  {
    id: "auth.password.signup",
    version: "1.0.0",
    level: "exact" as const,
    constraints: {},
    evidence: [],
    observed: false,
  },
];

/** A richer scenario: three benign "noise" steps around the one step that actually diverges. */
const REDUCE_SCENARIO: ScenarioSpec = {
  format: "supadiff.scenario",
  formatVersion: "1.0",
  id: "scn.fault.reduce-rls-leak",
  revision: "1",
  title: "reduce fixture",
  tags: ["fault-lab"],
  seed: "9",
  client: { library: "supabase-js", version: "2.97.0" },
  requirements: [],
  resources: [],
  actors: [
    {
      id: "actor.owner",
      kind: "user",
      credentialSource: { kind: "generated", recipe: { id: "fixture.password", version: "1" } },
      initialContext: "anonymous",
      sessionPolicy: "fresh-per-target",
    },
    {
      id: "actor.noise",
      kind: "user",
      credentialSource: {
        kind: "generated",
        recipe: { id: "fixture.noise-password", version: "1" },
      },
      initialContext: "anonymous",
      sessionPolicy: "fresh-per-target",
    },
  ],
  steps: [
    {
      id: "step.noise-signup",
      kind: "auth.signUp",
      phase: "bootstrap",
      actor: "actor.noise",
      input: { email: "noise@example.test", password: { $secretRef: "fixture.noise-password" } },
    },
    {
      id: "step.noise-select",
      kind: "data.select",
      phase: "exercise",
      input: { table: "unrelated", filters: [] },
    },
    {
      id: "step.probe",
      kind: "data.select",
      phase: "exercise",
      actor: "actor.owner",
      input: { table: "notes", filters: [{ field: "owner_id", op: "eq", value: "owner-1" }] },
    },
    {
      id: "step.noise-tail",
      kind: "data.select",
      phase: "exercise",
      dependsOn: ["step.probe"],
      input: { table: "also-unrelated", filters: [] },
    },
  ],
  cleanup: [],
  comparison: { policyId: "policy.fault-lab", policyVersion: "1" },
  expectedOutcomes: [],
  limits: {
    maxSteps: 10,
    maxWallTimeMs: 30000,
    maxArtifactBytes: 1000000,
    maxRequestsPerTarget: 20,
    maxHostedCostUsd: 0,
    maxParallelOperations: 1,
  },
  provenance: { origin: "authored", createdAt: "2026-01-01T00:00:00.000Z", author: "fault-lab" },
};

const POLICY: ComparisonPolicy = {
  format: "supadiff.comparison-policy",
  formatVersion: "1.0",
  policyId: "policy.fault-lab",
  policyVersion: "1",
  rules: [
    rule("data.select", "/status"),
    rule("data.select", "/rows"),
    rule("auth.signUp", "/status"),
    rule("auth.signUp", "/user/id"),
    rule("auth.signUp", "/user/email"),
  ],
};

function rule(operationId: string, observablePath: string) {
  return {
    id: `rule.fl-reduce-${operationId.replace(/\./g, "-").toLowerCase()}-${observablePath
      .split("/")
      .filter(Boolean)
      .join("-")
      .toLowerCase()}`,
    version: "1",
    selector: {
      service: operationId.startsWith("auth") ? "auth" : "data",
      operationId,
      operationVersion: "1",
      observablePath,
      referenceTargetSelector: { kind: "fake" },
      candidateTargetSelector: { kind: "fake" },
    },
    inputType: "any",
    rule: { kind: "exact" as const },
    strictness: "contract" as const,
    rationale: "reduce fixture",
    evidence: [],
  };
}

function targetSpecFor(slot: string, script: FakeScript): TargetSpec {
  return {
    id: slot,
    kind: "fake",
    runtime: { runtime: "node", version: process.version },
    config: { scriptId: slot, script } as never,
    credentialRefs: [],
    lifecycle: {
      allocation: "provision-new",
      isolation: "fresh-instance",
      readinessTimeoutMs: 2000,
      teardownTimeoutMs: 2000,
      cleanup: "always",
      keepOnFailure: "deny",
    },
    safety: {
      allowHosted: false,
      allowHostedCreate: false,
      allowHostedDestructive: false,
      maxHostedCostUsd: 0,
    },
  };
}

const noiseSignupBody = {
  status: 200,
  user: { id: "noise-user", email: "noise@example.test" },
  session: { access_token: "a", refresh_token: "r" },
};
const noiseSelectBody = { status: 200, rows: [] };

function referenceScript(): FakeScript {
  return {
    identity: identity(),
    declaredCapabilities: CAPS,
    steps: {
      "step.noise-signup": { category: "success", status: 200, body: noiseSignupBody },
      "step.noise-select": { category: "success", status: 200, body: noiseSelectBody },
      "step.probe": {
        category: "success",
        status: 200,
        body: { status: 200, rows: [{ id: 1, owner_id: "owner-1" }] },
      },
      "step.noise-tail": { category: "success", status: 200, body: noiseSelectBody },
    },
    teardownStatus: "complete",
  };
}

function faultyScript(): FakeScript {
  return {
    identity: identity(),
    declaredCapabilities: CAPS,
    steps: {
      "step.noise-signup": { category: "success", status: 200, body: noiseSignupBody },
      "step.noise-select": { category: "success", status: 200, body: noiseSelectBody },
      "step.probe": {
        category: "success",
        status: 200,
        body: {
          status: 200,
          rows: [
            { id: 1, owner_id: "owner-1" },
            { id: 2, owner_id: "owner-2" },
          ],
        },
      },
      "step.noise-tail": { category: "success", status: 200, body: noiseSelectBody },
    },
    teardownStatus: "complete",
  };
}

async function computeExpectedSignature() {
  const referenceSpec = targetSpecFor("reference", referenceScript());
  const candidateSpec = targetSpecFor("faulty", faultyScript());
  const driver = new FakeTargetDriver({
    reference: referenceScript(),
    faulty: faultyScript(),
  });
  const handles: TargetHandle[] = [
    { slot: "reference", spec: referenceSpec, driver },
    { slot: "faulty", spec: candidateSpec, driver },
  ];
  const result = await runScenario(REDUCE_SCENARIO, handles, { policy: POLICY });
  const scenarioDigest = computeScenarioDigest(REDUCE_SCENARIO);
  const ref = result.targets.get("reference")!;
  const cand = result.targets.get("faulty")!;
  const results = [];
  for (const step of REDUCE_SCENARIO.steps) {
    const refObs = ref.semanticObservations.get(`${step.id}:1`);
    const candObs = cand.semanticObservations.get(`${step.id}:1`);
    if (!refObs || !candObs) continue;
    results.push(
      ...compareStep({
        scenarioId: REDUCE_SCENARIO.id,
        scenarioDigest,
        scenarioRevision: REDUCE_SCENARIO.revision,
        stepId: step.id,
        referenceSlot: "reference",
        candidateSlot: "faulty",
        referenceTarget: { kind: "fake", version: "1.0.0" },
        candidateTarget: { kind: "fake", version: "1.0.0" },
        referenceObservation: refObs,
        candidateObservation: candObs,
        referenceRawDigest: sha256OfCanonicalJson(ref.rawObservations.get(`${step.id}:1`) as never),
        candidateRawDigest: sha256OfCanonicalJson(
          cand.rawObservations.get(`${step.id}:1`) as never,
        ),
        policy: POLICY,
        registry: [],
        now: new Date(),
      }),
    );
  }
  const signatures = buildDivergenceSignatures(REDUCE_SCENARIO, results, "fake", "fake");
  const sig = signatures.find((s) => s.stepId === "step.probe");
  if (!sig) throw new Error("expected a divergence signature at step.probe");
  return sig;
}

describe("L10 state-aware reducer (§11)", () => {
  it("shrinks noise steps while preserving the exact divergence signature", async () => {
    const expectedSignature = await computeExpectedSignature();
    const referenceSpec = targetSpecFor("reference", referenceScript());
    const candidateSpec = targetSpecFor("faulty", faultyScript());

    const ctx: ReductionContext = {
      referenceSpec,
      candidateSpec,
      buildDriver: (spec) =>
        new FakeTargetDriver({
          [spec.id]: spec.id === "reference" ? referenceScript() : faultyScript(),
        }),
      policy: POLICY,
      knownDivergences: [],
      expectedSignature,
      toolchainId: "test",
    };

    const result = await reduceArtifact(REDUCE_SCENARIO, "step.probe", ctx);

    expect(result.minimality).not.toBe("inconclusive-flaky");
    expect(result.reducedStepCount).toBeLessThan(result.originalStepCount);
    expect(result.reduced.steps.some((s) => s.id === "step.probe")).toBe(true);
    // The noise steps that contributed nothing to the divergence are gone.
    expect(result.reduced.steps.some((s) => s.id === "step.noise-signup")).toBe(false);
    expect(result.reduced.steps.some((s) => s.id === "step.noise-tail")).toBe(false);
    // The noise actor (only used by the removed signup step) is pruned too.
    expect(result.reduced.actors.some((a) => a.id === "actor.noise")).toBe(false);
    expect(result.reduced.actors.some((a) => a.id === "actor.owner")).toBe(true);
  });

  it("refuses to reduce a divergence that does not reproduce 3/3 fresh replays (flaky)", async () => {
    const expectedSignature = await computeExpectedSignature();
    const referenceSpec = targetSpecFor("reference", referenceScript());
    const candidateSpec = targetSpecFor("faulty", faultyScript());

    let call = 0;
    const ctx: ReductionContext = {
      referenceSpec,
      candidateSpec,
      buildDriver: (spec) => {
        call++;
        // Flip the candidate's script to the *benign* (non-diverging) body every other
        // provision, so only ~2/3 of replays reproduce the signature.
        const useBenign = spec.id === "faulty" && call % 3 === 0;
        const script = spec.id === "reference" ? referenceScript() : faultyScript();
        if (useBenign)
          script.steps["step.probe"]!.body = {
            status: 200,
            rows: [{ id: 1, owner_id: "owner-1" }],
          };
        return new FakeTargetDriver({ [spec.id]: script });
      },
      policy: POLICY,
      knownDivergences: [],
      expectedSignature,
      toolchainId: "test",
    };

    const result = await reduceArtifact(REDUCE_SCENARIO, "step.probe", ctx);
    expect(result.minimality).toBe("inconclusive-flaky");
    expect(result.reduced).toBe(REDUCE_SCENARIO);
  });
});
