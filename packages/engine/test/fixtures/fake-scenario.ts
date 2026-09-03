import type { ScenarioSpec, TargetCapability, TargetIdentity } from "@supadiff/spec";

export function fakeIdentity(overrides: Partial<TargetIdentity> = {}): TargetIdentity {
  return {
    targetKind: "fake",
    implementation: "fake-target",
    implementationVersion: "1.0.0",
    runtime: { runtime: "node", version: "22.10.0" },
    clientVersion: "0.0.0",
    platform: { os: "linux", arch: "x64" },
    effectiveConfigDigest: "sha256:" + "0".repeat(64),
    observedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

export function exactCapability(id: string, version = "1.0.0"): TargetCapability {
  return { id, version, level: "exact", constraints: {}, evidence: [], observed: false };
}

/** A two-step scenario: auth.signUp (capturing an id) then data.select using that capture. */
export function twoStepScenario(overrides: Partial<ScenarioSpec> = {}): ScenarioSpec {
  const base: ScenarioSpec = {
    format: "supadiff.scenario",
    formatVersion: "1.0",
    id: "scn.fake-two-step",
    revision: "1",
    title: "Two-step fake scenario",
    tags: ["l2"],
    seed: "7",
    client: { library: "supabase-js", version: "2.97.0" },
    requirements: [{ capability: "data.select", range: "^1.0.0", accept: ["exact"] }],
    resources: [],
    actors: [
      {
        id: "actor.owner",
        kind: "user",
        credentialSource: { kind: "generated", recipe: { id: "fixture.password", version: "1" } },
        initialContext: "anonymous",
        sessionPolicy: "fresh-per-target",
      },
    ],
    steps: [
      {
        id: "step.signup",
        kind: "auth.signUp",
        phase: "bootstrap",
        actor: "actor.owner",
        input: { email: "owner@example.test", password: { $secretRef: "fixture.password" } },
        capture: [
          {
            name: "owner-id",
            from: { kind: "semantic", field: "id" },
            valueType: "identifier",
            sensitivity: "identifier",
            required: true,
          },
        ],
      },
      {
        id: "step.select",
        kind: "data.select",
        phase: "exercise",
        actor: "actor.owner",
        dependsOn: ["step.signup"],
        input: {
          table: "todos",
          filters: [{ field: "owner_id", op: "eq", value: { $ref: "capture:owner-id" } }],
        },
      },
    ],
    cleanup: [
      {
        id: "cleanup.remove-owner",
        operation: { id: "data.delete", version: "1" },
        input: {
          table: "users",
          filters: [{ field: "id", op: "eq", value: { $ref: "capture:owner-id" } }],
        },
        timeoutMs: 2000,
      },
    ],
    comparison: { policyId: "policy.fake", policyVersion: "1" },
    expectedOutcomes: [],
    limits: {
      maxSteps: 10,
      maxWallTimeMs: 30_000,
      maxArtifactBytes: 10_000_000,
      maxRequestsPerTarget: 20,
      maxHostedCostUsd: 0,
      maxParallelOperations: 1,
    },
    provenance: { origin: "authored", createdAt: "2026-09-03T00:00:00.000Z", author: "test" },
  };
  return { ...base, ...overrides };
}

export function fakeTargetSpec(id: string, scriptId: string) {
  return {
    id,
    kind: "fake" as const,
    runtime: { runtime: "node", version: "22.10.0" },
    config: { scriptId },
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
