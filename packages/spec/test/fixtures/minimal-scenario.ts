import type { ScenarioSpec } from "../../src/index.js";

export function minimalScenario(overrides: Partial<ScenarioSpec> = {}): ScenarioSpec {
  const base: ScenarioSpec = {
    format: "supadiff.scenario",
    formatVersion: "1.0",
    id: "scn.minimal",
    revision: "1",
    title: "Minimal valid scenario",
    tags: ["l1"],
    seed: "42",
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
        id: "auth.signup.owner",
        kind: "auth.signUp",
        phase: "bootstrap",
        actor: "actor.owner",
        input: { email: "owner@example.test", password: { $secretRef: "fixture.password" } },
        capture: [
          {
            name: "owner-id",
            from: { kind: "semantic", field: "subject" },
            valueType: "identifier",
            sensitivity: "identifier",
            required: true,
          },
        ],
      },
      {
        id: "data.select.todo-01",
        kind: "data.select",
        phase: "exercise",
        actor: "actor.owner",
        dependsOn: ["auth.signup.owner"],
        input: {
          table: "todos",
          filters: [{ field: "owner_id", op: "eq", value: { $ref: "capture:owner-id" } }],
        },
      },
    ],
    cleanup: [],
    comparison: { policyId: "policy.minimal", policyVersion: "1" },
    expectedOutcomes: [],
    limits: {
      maxSteps: 50,
      maxWallTimeMs: 60_000,
      maxArtifactBytes: 10_000_000,
      maxRequestsPerTarget: 50,
      maxHostedCostUsd: 0,
      maxParallelOperations: 1,
    },
    provenance: { origin: "authored", createdAt: "2026-09-03T00:00:00.000Z", author: "test" },
  };
  return { ...base, ...overrides };
}
