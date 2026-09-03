import type { ComparisonPolicy, ScenarioSpec, TargetCapability } from "@supadiff/spec";
import type { FakeScript } from "@supadiff/engine";

/**
 * Dogfood fault lab (Architecture Contract §15.5): a small set of deliberately
 * incompatible scripted target variants, one per required fault class, each with a
 * benign counterpart. These are `FakeTargetDriver` scripts — test infrastructure only,
 * never evidence about Supalite/Supabase (§15.2) — because the fault lab's job is to
 * prove SupaDiff's own comparator catches these six classes and does not confuse
 * benign nondeterminism with them, exactly the harness self-test the contract asks for.
 */

const CAPS: TargetCapability[] = [
  {
    id: "data.select",
    version: "1.0.0",
    level: "exact",
    constraints: {},
    evidence: [],
    observed: false,
  },
  {
    id: "data.insert",
    version: "1.0.0",
    level: "exact",
    constraints: {},
    evidence: [],
    observed: false,
  },
  {
    id: "auth.password.signup",
    version: "1.0.0",
    level: "exact",
    constraints: {},
    evidence: [],
    observed: false,
  },
  {
    id: "storage.object.read",
    version: "1.0.0",
    level: "exact",
    constraints: {},
    evidence: [],
    observed: false,
  },
];

function identity(label: string) {
  return {
    targetKind: "fake" as const,
    implementation: `fault-lab-${label}`,
    implementationVersion: "1.0.0",
    runtime: { runtime: "node", version: process.version },
    clientVersion: "0.0.0",
    platform: { os: "linux", arch: "x64" },
    effectiveConfigDigest: `sha256:${"0".repeat(64)}`,
    observedAt: "2026-01-01T00:00:00.000Z",
  };
}

function scenarioFor(
  id: string,
  kind: string,
  input: object,
  extra: Partial<ScenarioSpec> = {},
): ScenarioSpec {
  return {
    format: "supadiff.scenario",
    formatVersion: "1.0",
    id,
    revision: "1",
    title: id,
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
    ],
    steps: [
      {
        id: "step.probe",
        kind: kind as never,
        phase: "exercise",
        actor: "actor.owner",
        input: input as never,
      },
    ],
    cleanup: [],
    comparison: { policyId: "policy.fault-lab", policyVersion: "1" },
    expectedOutcomes: [],
    limits: {
      maxSteps: 5,
      maxWallTimeMs: 30000,
      maxArtifactBytes: 1000000,
      maxRequestsPerTarget: 10,
      maxHostedCostUsd: 0,
      maxParallelOperations: 1,
    },
    provenance: { origin: "authored", createdAt: "2026-01-01T00:00:00.000Z", author: "fault-lab" },
    ...extra,
  };
}

function script(body: unknown, status = 200): FakeScript {
  return {
    identity: identity("target"),
    declaredCapabilities: CAPS,
    steps: {
      "step.probe": { category: status >= 400 ? "application-error" : "success", status, body },
    },
    teardownStatus: "complete",
  };
}

export type FaultId =
  | "rls-leak"
  | "partial-write"
  | "returning-leak"
  | "auth-subject-swap"
  | "storage-owner-loss"
  | "normalization-trap";

export interface FaultDefinition {
  id: FaultId;
  scenario: ScenarioSpec;
  observablePath: string;
  referenceScript: FakeScript;
  faultyScript: FakeScript;
  benignScript: FakeScript;
}

export const FAULT_DEFINITIONS: FaultDefinition[] = [
  {
    id: "rls-leak",
    scenario: scenarioFor("scn.fault.rls-leak", "data.select", {
      table: "notes",
      filters: [{ field: "owner_id", op: "eq", value: "owner-1" }],
    }),
    observablePath: "/rows",
    referenceScript: script({ status: 200, rows: [{ id: 1, owner_id: "owner-1" }] }),
    faultyScript: script({
      status: 200,
      rows: [
        { id: 1, owner_id: "owner-1" },
        { id: 2, owner_id: "owner-2" },
      ],
    }),
    benignScript: script({ status: 200, rows: [{ owner_id: "owner-1", id: 1 }] }),
  },
  {
    id: "partial-write",
    scenario: scenarioFor("scn.fault.partial-write", "data.insert", {
      table: "notes",
      rows: [{ id: 1, owner_id: "owner-1" }],
    }),
    observablePath: "/rows",
    referenceScript: script({ status: 409, rows: [] }, 409),
    faultyScript: script({ status: 409, rows: [{ id: 1, owner_id: "owner-1" }] }, 409),
    benignScript: script({ status: 409, rows: [] }, 409),
  },
  {
    id: "returning-leak",
    scenario: scenarioFor("scn.fault.returning-leak", "data.insert", {
      table: "notes",
      rows: [{ id: 10, owner_id: "owner-1" }],
      returning: true,
    }),
    observablePath: "/rows",
    referenceScript: script({ status: 201, rows: [{ id: 10, owner_id: "owner-1" }] }, 201),
    faultyScript: script(
      {
        status: 201,
        rows: [
          { id: 10, owner_id: "owner-1" },
          { id: 11, owner_id: "owner-2" },
        ],
      },
      201,
    ),
    benignScript: script({ status: 201, rows: [{ owner_id: "owner-1", id: 10 }] }, 201),
  },
  {
    id: "auth-subject-swap",
    scenario: scenarioFor("scn.fault.auth-subject-swap", "auth.signUp", {
      email: "owner@example.test",
      password: { $secretRef: "fixture.password" },
    }),
    observablePath: "/user/email",
    referenceScript: script({
      status: 200,
      user: { id: "user-1", email: "owner@example.test" },
      session: { access_token: "ref-a", refresh_token: "ref-r" },
    }),
    faultyScript: script({
      status: 200,
      user: { id: "user-1", email: "intruder@example.test" },
      session: { access_token: "cand-a", refresh_token: "cand-r" },
    }),
    benignScript: script({
      status: 200,
      user: { id: "user-1", email: "owner@example.test" },
      session: { access_token: "different-random-a", refresh_token: "different-random-r" },
    }),
  },
  {
    id: "storage-owner-loss",
    scenario: scenarioFor("scn.fault.storage-owner-loss", "observe.storageObject", {
      bucket: "avatars",
      path: "owner-1/avatar.png",
    }),
    observablePath: "/owner",
    referenceScript: script({ owner: "owner-1", bytesDigest: "sha256:abc123", contentLength: 512 }),
    faultyScript: script({ owner: "owner-2", bytesDigest: "sha256:abc123", contentLength: 512 }),
    benignScript: script({ owner: "owner-1", bytesDigest: "sha256:abc123", contentLength: 512 }),
  },
  {
    id: "normalization-trap",
    scenario: scenarioFor("scn.fault.normalization-trap", "data.select", {
      table: "notes",
      filters: [{ field: "id", op: "eq", value: 1 }],
    }),
    observablePath: "/rows",
    referenceScript: script({ status: 200, rows: [{ id: 1, note: null }] }),
    faultyScript: script({ status: 200, rows: [{ id: 1 }] }),
    benignScript: script({ status: 200, rows: [{ id: 1, note: null }] }),
  },
];

/** One shared policy: exact comparison on every observable path any fault definition uses. */
export const FAULT_LAB_POLICY: ComparisonPolicy = {
  format: "supadiff.comparison-policy",
  formatVersion: "1.0",
  policyId: "policy.fault-lab",
  policyVersion: "1",
  rules: [
    ruleFor("data", "data.select", "/status"),
    ruleFor("data", "data.select", "/rows"),
    ruleFor("data", "data.insert", "/status"),
    ruleFor("data", "data.insert", "/rows"),
    ruleFor("auth", "auth.signUp", "/status"),
    ruleFor("auth", "auth.signUp", "/user/id"),
    ruleFor("auth", "auth.signUp", "/user/email"),
    ruleFor("storage", "observe.storageObject", "/owner"),
    ruleFor("storage", "observe.storageObject", "/bytesDigest"),
    ruleFor("storage", "observe.storageObject", "/contentLength"),
  ],
};

function ruleFor(service: string, operationId: string, observablePath: string) {
  return {
    id: `rule.fault-lab-${operationId.replace(/\./g, "-").toLowerCase()}-${observablePath
      .split("/")
      .filter(Boolean)
      .join("-")
      .toLowerCase()}`,
    version: "1",
    selector: {
      service,
      operationId,
      operationVersion: "1",
      observablePath,
      referenceTargetSelector: { kind: "fake" },
      candidateTargetSelector: { kind: "fake" },
    },
    inputType: "any",
    rule: { kind: "exact" as const },
    strictness: "contract" as const,
    rationale: "Fault lab: exact equality on the surface each deliberate fault mutates.",
    evidence: [],
  };
}
